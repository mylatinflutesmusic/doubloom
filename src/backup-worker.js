import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { networkParams } from './params.js';
import { createNodeBackup, restoreNodeBackup } from './backup.js';

/**
 * Worker entry for node backups and their periodic verification. Writing an
 * archive and validating it again — gzip, replaying every block through Chain,
 * and the deliberately slow scrypt wallet decryption — is CPU-bound for a
 * second or more on a real chain, so it runs on this thread and leaves the node
 * free to serve peers, the API and the explorer.
 *
 * One thread serves every job the node runs, so it waits for messages rather
 * than reading `workerData` once and exiting: an archive written at start-up
 * and a verification hours later both arrive here. A job that fails reports the
 * error and leaves the thread ready for the next one. The passphrase is handed
 * over in worker memory; it is never written anywhere.
 */
function runJob(job) {
  const params = networkParams(job.network);

  if (job.mode === 'verify') {
    // A throwaway directory, removed before the result is reported so a
    // successful or failed restore leaves nothing behind either way.
    const directory = fs.mkdtempSync(
      path.join(job.tempRoot ?? os.tmpdir(), 'doubloom-verify-'),
    );
    try {
      const restored = restoreNodeBackup({
        source: job.source,
        params,
        chainFile: path.join(directory, params.name, 'chain.json'),
        walletFile: path.join(directory, params.name, 'wallet.json'),
        passphrase: job.passphrase,
      });
      return {
        height: restored.height,
        tip: restored.tip,
        keys: restored.keys,
      };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  return createNodeBackup({
    params,
    chainFile: job.chainFile,
    walletFile: job.walletFile,
    destination: job.destination,
    passphrase: job.passphrase,
    ...(job.createdAt ? { createdAt: job.createdAt } : {}),
  });
}

parentPort?.on('message', (job) => {
  let message;
  try {
    message = { id: job?.id, ok: true, result: runJob(job ?? {}) };
  } catch (error) {
    message = {
      id: job?.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort.postMessage(message);
});
