import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_FILE = fileURLToPath(new URL('./backup-worker.js', import.meta.url));

/**
 * One backup thread, kept for as long as the node runs. Writing an archive and
 * restoring one to check it are CPU-bound for seconds on a real chain, so both
 * belong off the node's event loop — but a thread spawn and its module graph
 * per job is overhead a schedule that runs hourly (and verifies hourly) pays for
 * nothing. The thread starts on the first job and is reused after that.
 *
 * Jobs are handed over one at a time. The scheduler already serialises backups
 * and verification, so this queue is for callers that do not; a job is posted
 * only once the previous one has reported, which is also what keeps the single
 * thread's memory in check.
 *
 * The thread is unref'd while idle, so a node that has been closed can exit
 * without waiting for it, and ref'd while a job is outstanding so a process
 * waiting on a backup does not exit underneath it.
 */
export function createBackupWorker() {
  let worker = null;
  let nextId = 1;
  let spawned = 0;
  let closing = false;
  // Set when the node closes mid-job: the archive in flight is allowed to
  // finish, because killing the thread mid-write would leave a truncated file.
  let stopAfterJob = false;
  // Set while the running job is being cancelled. The exit that follows is then
  // reported as a cancellation, not as a thread that died.
  let cancellation = null;
  // Resolved when the thread has actually been told to stop, so a shutting-down
  // process can wait for that last archive instead of exiting over it.
  let notifyStopped = null;
  const pending = new Map();
  const queue = [];

  function spawn() {
    const instance = new Worker(WORKER_FILE);
    spawned += 1;
    instance.unref();

    instance.on('message', (message) => {
      const job = pending.get(message?.id);
      if (!job) {
        return;
      }
      // A progress report is not the end of the job: hand it to the caller and
      // keep waiting for the result.
      if (message.progress) {
        job.onProgress?.(message.progress);
        return;
      }
      pending.delete(job.id);
      if (message.ok) {
        job.resolve(message.result);
      } else {
        job.reject(new Error(message.error ?? 'backup worker failed'));
      }
      if (stopAfterJob && pending.size === 0) {
        stopThread();
        return;
      }
      if (pending.size === 0) {
        instance.unref();
      }
      drain();
    });

    instance.on('error', (error) => fail(error));
    instance.on('exit', (code) => {
      if (worker === instance) {
        worker = null;
      }
      if (closing) {
        // A thread that dies while the node is shutting down must not leave a
        // job waiting for a message that will never come.
        const stopped = new Error('the backup worker was stopped');
        for (const job of pending.values()) {
          job.reject(stopped);
        }
        pending.clear();
        stopAfterJob = false;
        return;
      }
      if (cancellation) {
        // The operator stopped this one: reject only the job that was running,
        // and leave the queue to start again on a fresh thread.
        const error = cancellation;
        cancellation = null;
        for (const job of pending.values()) {
          pending.delete(job.id);
          job.reject(error);
        }
        if (queue.length > 0) {
          drain();
        }
        return;
      }
      // A thread that dies takes its job with it, but the next one starts a
      // fresh worker instead of waiting for a restart of the node.
      fail(new Error(`backup worker exited (code ${code})`));
    });

    return instance;
  }

  function drain() {
    if (closing || pending.size > 0 || queue.length === 0) {
      return;
    }
    if (!worker) {
      worker = spawn();
    }
    const job = queue.shift();
    pending.set(job.id, job);
    worker.ref();
    try {
      worker.postMessage(job.message);
    } catch (error) {
      // A thread that cannot accept the job is no use to the rest of the queue.
      pending.delete(job.id);
      worker.unref();
      worker = null;
      job.reject(error instanceof Error ? error : new Error(String(error)));
      drain();
    }
  }

  function stopThread() {
    stopAfterJob = false;
    const instance = worker;
    worker = null;
    if (instance) {
      instance.terminate().catch(() => {});
    }
    const notify = notifyStopped;
    notifyStopped = null;
    notify?.();
  }

  function fail(error) {
    const instance = worker;
    worker = null;
    stopAfterJob = false;
    if (instance) {
      instance.terminate().catch(() => {});
    }
    const notify = notifyStopped;
    notifyStopped = null;
    notify?.();
    const rejection = error instanceof Error ? error : new Error(String(error));
    for (const job of queue.splice(0)) {
      job.reject(rejection);
    }
    for (const job of pending.values()) {
      job.reject(rejection);
    }
    pending.clear();
  }

  function enqueue(message, onProgress = null) {
    if (closing) {
      return Promise.reject(new Error('the backup worker is stopped'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      queue.push({ id, message: { ...message, id }, resolve, reject, onProgress });
      drain();
    });
  }

  return {
    runBackup(job) {
      return enqueue(
        {
          mode: 'backup',
          network: job.params.name,
          chainFile: job.chainFile,
          walletFile: job.walletFile,
          destination: job.destination,
          passphrase: job.passphrase,
          createdAt: job.createdAt,
        },
        job.onProgress,
      );
    },
    verifyBackup(job) {
      return enqueue({
        mode: 'verify',
        network: job.params.name,
        source: job.source,
        passphrase: job.passphrase,
        tempRoot: job.tempRoot,
      });
    },
    /**
     * Stop the job that is running, if any. The thread is terminated — a
     * backup spends its time in synchronous work, so there is no safe point to
     * ask it to stop — and its promise is rejected with an error marked
     * `cancelled`, which is what tells the caller the archive is not usable.
     * Returns false when nothing was running, so a caller can report that.
     */
    cancelRunning() {
      if (pending.size === 0) {
        return false;
      }
      const error = new Error('backup cancelled by the operator');
      error.cancelled = true;
      cancellation = error;
      const instance = worker;
      worker = null;
      instance?.terminate().catch(() => {});
      return true;
    },
    /** Diagnostic: how many threads this instance started, and how many jobs. */
    stats() {
      return {
        spawned,
        jobs: nextId - 1,
        pending: pending.size,
        queued: queue.length,
      };
    },
    /**
     * Stop accepting work and resolve once the thread is on its way out. A job
     * already running finishes first, so a backup in progress still produces a
     * complete archive; anything merely queued is refused. Await this before a
     * process exits, or that last archive is cut off mid-write.
     */
    close() {
      closing = true;
      const stopped = new Error('the backup worker was stopped');
      for (const job of queue.splice(0)) {
        job.reject(stopped);
      }
      if (pending.size > 0) {
        stopAfterJob = true;
        return new Promise((resolve) => {
          notifyStopped = resolve;
        });
      }
      stopThread();
      return Promise.resolve();
    },
  };
}
