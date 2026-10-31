import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeBackup, restoreNodeBackup } from './backup.js';

/**
 * Periodic verified node backups. The schedule is opt-in: without a backup
 * directory the node behaves exactly as before. Each tick writes the same
 * archive as `doubloom backup`, verifies it, and then applies the retention
 * tiers: the newest archive of each of the last N hours, days and weeks is
 * kept, so a sweep covers recent minutes, recent days and recent weeks
 * without storing every snapshot.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Hourly snapshots cover the last day in detail, daily ones the last week,
 * weekly ones the last month. A node backing up hourly therefore holds ~35
 * archives: 24 from today, 7 daily remnants, 4 weekly ones.
 */
const DEFAULT_RETENTION = Object.freeze({ hourly: 24, daily: 7, weekly: 4 });
const RETENTION_TIERS = ['hourly', 'daily', 'weekly'];
const DEFAULT_FIRST_DELAY_MS = 10_000;
/**
 * How long the first backup waits for peer sync to settle. A node whose only
 * peer never answers would otherwise wait forever and never write an archive,
 * so the wait is capped: after this long it snapshots what it has instead.
 */
const DEFAULT_FIRST_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_WATCHDOG_MS = 10_000;
const DEFAULT_RECOVERY_HISTORY_LIMIT = 5;
//: A backup older than this many intervals is stale unless configured.
const DEFAULT_MAX_AGE_FACTOR = 2;
const MIN_DEFAULT_MAX_AGE_MS = 60_000;
// Restoring an archive is the only way to know it still restores, so the newest
// one is checked periodically. Six hours is often enough to catch a corrupt
// write before it ages out of retention, and rare enough to be cheap.
const DEFAULT_VERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATUS_VERSION = 1;

export function backupStatusFile(chainFile) {
  return path.join(path.dirname(chainFile), 'backup-status.json');
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '—';
  }
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (milliseconds < 3_600_000) {
    const minutes = milliseconds / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  }
  const hours = milliseconds / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function isRecovery(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    Number.isFinite(Date.parse(entry.at)) &&
    typeof entry.reason === 'string'
  );
}

/** Read the persisted status, ignoring missing or unrelated files. */
export function loadBackupStatus({ statusFile, network }) {
  try {
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (data?.version !== STATUS_VERSION || data.network !== network) {
      return null;
    }
    const lastBackup =
      data.lastBackup &&
      typeof data.lastBackup === 'object' &&
      typeof data.lastBackup.at === 'string' &&
      Number.isFinite(data.lastBackup.height) &&
      typeof data.lastBackup.path === 'string'
        ? data.lastBackup
        : null;
    const recoveryHistoryLimit =
      Number.isInteger(data.recoveryHistoryLimit) &&
      data.recoveryHistoryLimit > 0
        ? data.recoveryHistoryLimit
        : DEFAULT_RECOVERY_HISTORY_LIMIT;
    const recoveryHistory = (
      Array.isArray(data.recoveryHistory) ? data.recoveryHistory : []
    ).filter(isRecovery);
    if (
      isRecovery(data.lastRecovery) &&
      !recoveryHistory.some(
        (entry) =>
          entry.at === data.lastRecovery.at &&
          entry.reason === data.lastRecovery.reason,
      )
    ) {
      recoveryHistory.push(data.lastRecovery);
    }
    recoveryHistory.sort(
      (left, right) => Date.parse(right.at) - Date.parse(left.at),
    );
    recoveryHistory.length = Math.min(
      recoveryHistory.length,
      recoveryHistoryLimit,
    );
    const lastRecovery = recoveryHistory[0] ?? null;
    return {
      pid: Number.isInteger(data.pid) ? data.pid : null,
      directory: typeof data.directory === 'string' ? data.directory : null,
      firstDelayMs: Number.isFinite(data.firstDelayMs)
        ? data.firstDelayMs
        : null,
      firstMaxWaitMs: Number.isFinite(data.firstMaxWaitMs)
        ? data.firstMaxWaitMs
        : null,
      intervalMs: Number.isFinite(data.intervalMs) ? data.intervalMs : null,
      maxAgeMs: Number.isFinite(data.maxAgeMs) ? data.maxAgeMs : null,
      retention: readRetention(data),
      lastBackup,
      lastRecovery,
      recoveryHistory,
      recoveryHistoryLimit,
      nextRunAt:
        typeof data.nextRunAt === 'string' ? data.nextRunAt : null,
      waitingForSync: data.waitingForSync === true,
      lastAttemptAt: data.lastAttemptAt ?? null,
      lastError: data.lastError ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read the persisted retention limits. Files written before tiers existed hold
 * a single `keep` count; treat that as "this many hourly archives" so an
 * upgraded node does not suddenly discard the history it had.
 */
function readRetention(data) {
  if (data.retention && typeof data.retention === 'object') {
    try {
      return normalizeRetention(data.retention);
    } catch {
      return { ...DEFAULT_RETENTION };
    }
  }
  if (Number.isInteger(data.keep) && data.keep > 0) {
    return { hourly: data.keep, daily: 0, weekly: 0 };
  }
  return null;
}

function saveBackupStatus(statusFile, payload, logError) {
  const temporary = `${statusFile}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, statusFile);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    logError(`could not write backup status: ${error.message}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function backupRecoveryDelayMs({
  nowMs,
  lastBackupAt,
  intervalMs,
  firstDelayMs,
  firstBackupPending,
}) {
  if (firstBackupPending) {
    return firstDelayMs;
  }
  const last = Date.parse(lastBackupAt);
  if (!Number.isFinite(last)) {
    return 0;
  }
  return Math.min(intervalMs, Math.max(0, intervalMs - (nowMs - last)));
}

export function backupFileName(network, date = new Date()) {
  const digits = date.toISOString().replace(/\D/g, '').slice(0, 17);
  const stamp = `${digits.slice(0, 8)}-${digits.slice(8)}`;
  return `doubloom-${network}-backup-${stamp}.json.gz`;
}

// Matches compressed archives and the plain-JSON ones written before
// compression existed, so retention cleans up both.
function archivePattern(network) {
  return new RegExp(
    `^doubloom-${escapeRegExp(network)}-backup-\\d{8}-\\d{9}(?:-\\d+)?\\.json(?:\\.gz)?$`,
  );
}

/** Fill in missing tiers and reject values that would keep nothing. */
export function normalizeRetention(retention = {}) {
  const normalized = {};
  for (const tier of RETENTION_TIERS) {
    const value = retention?.[tier] ?? DEFAULT_RETENTION[tier];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`backup retention for ${tier} must be a non-negative integer`);
    }
    normalized[tier] = value;
  }
  if (RETENTION_TIERS.every((tier) => normalized[tier] === 0)) {
    throw new Error('backup retention must keep at least one archive');
  }
  return normalized;
}

/** `2026-10-31T03:19:01.464Z` keyed by hour, day and ISO week. */
function retentionBuckets(date) {
  const iso = date.toISOString();
  // The ISO week is the week of this date's Thursday, which is how the
  // year/week pair stays unambiguous at the turn of the year.
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const mondayOffset = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - mondayOffset + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (thursday.getTime() - firstThursday.getTime()) / 86_400_000 / 7 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7) / 7,
    );
  return {
    hour: iso.slice(0, 13), // YYYY-MM-DDTHH
    day: iso.slice(0, 10), // YYYY-MM-DD
    week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`,
  };
}

const TIER_LABELS = Object.freeze({
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
});

/**
 * Which retention tiers keep each archive: a Map from file name to the tier
 * names that selected it, in hourly, daily, weekly order. An archive no tier
 * selects is absent from the map — it is waiting to be pruned.
 *
 * Each tier is evaluated independently over the whole set, then the results are
 * unioned. That is what makes a dense schedule collapse as it ages: an archive
 * that is the newest of its hour is also usually the newest of its day and week,
 * so it fills all three slots instead of leaving the day slot to be taken by an
 * older archive from the same day. Reporting which tier did the keeping is only
 * a matter of recording each selection rather than only the union.
 */
export function retentionAssignments(archives, retention = DEFAULT_RETENTION) {
  const limits = normalizeRetention(retention);
  // Callers hold archive times either way: pruning reads names through a Date,
  // while a listing reports the ISO timestamp it wrote.
  const newestFirst = archives
    .map((archive) => ({
      ...archive,
      at: archive.at instanceof Date ? archive.at : new Date(archive.at),
    }))
    .sort(
      (left, right) =>
        right.at.getTime() - left.at.getTime() ||
        right.name.localeCompare(left.name),
    );
  const assignments = new Map();

  for (const tier of [
    { key: 'hour', limit: limits.hourly },
    { key: 'day', limit: limits.daily },
    { key: 'week', limit: limits.weekly },
  ]) {
    if (tier.limit === 0) {
      continue;
    }
    const seen = new Set();
    for (const archive of newestFirst) {
      if (seen.size >= tier.limit) {
        break;
      }
      const bucket = retentionBuckets(archive.at)[tier.key];
      if (seen.has(bucket)) {
        continue;
      }
      seen.add(bucket);
      const tiers = assignments.get(archive.name) ?? [];
      tiers.push(TIER_LABELS[tier.key]);
      assignments.set(archive.name, tiers);
    }
  }
  return assignments;
}

/** The archives retention keeps: the newest of each of the last hours, days and
 * ISO weeks, as a set of file names. */
export function selectRetained(archives, retention = DEFAULT_RETENTION) {
  return new Set(retentionAssignments(archives, retention).keys());
}

/**
 * The archives currently on disk for a network, newest first. Only names this
 * module writes are returned — the same pattern retention prunes — so nothing
 * else in the directory can be listed or offered for download.
 */
export function listArchives({ directory, network }) {
  const pattern = archivePattern(network);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .filter((name) => pattern.test(name))
    .map((name) => {
      try {
        const stats = fs.statSync(path.join(directory, name));
        return {
          name,
          bytes: stats.size,
          mtimeMs: stats.mtimeMs,
          at: archiveTime(name, stats.mtimeMs).toISOString(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/**
 * Delete the automatic archives the retention tiers do not keep. Returns the
 * file names that were removed. Unrelated files are never touched.
 */
export function pruneBackups({ directory, network, retention = DEFAULT_RETENTION }) {
  const pattern = archivePattern(network);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }

  const files = names
    .filter((name) => pattern.test(name))
    .map((name) => {
      try {
        const stats = fs.statSync(path.join(directory, name));
        return { name, at: archiveTime(name, stats.mtimeMs) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const kept = selectRetained(files, retention);

  const removed = [];
  for (const file of files) {
    if (kept.has(file.name)) {
      continue;
    }
    try {
      fs.rmSync(path.join(directory, file.name), { force: true });
      removed.push(file.name);
    } catch {
      // A file we cannot remove should not stop later backups.
    }
  }
  return removed;
}

/**
 * The UTC time an archive name encodes, falling back to its mtime for names
 * written by other tools. Names carry milliseconds, so same-second archives
 * still order correctly.
 */
function archiveTime(name, fallbackMs) {
  const match = name.match(
    /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})(?:-\d+)?\.json(?:\.gz)?$/,
  );
  if (!match) {
    return new Date(fallbackMs);
  }
  const [, year, month, day, hours, minutes, seconds, millis] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      Number(millis),
    ),
  );
  return Number.isNaN(date.getTime()) ? new Date(fallbackMs) : date;
}

function nextPath(directory, network, date) {
  const base = backupFileName(network, date).replace(/\.json(?:\.gz)?$/, '');
  let candidate = path.join(directory, `${base}.json`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${suffix}.json`);
    suffix += 1;
  }
  return candidate;
}

function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

/**
 * Restore an archive into a throwaway directory and remove it again. Restoring
 * validates the chain, the wallet and the passphrase, so success means the
 * archive is usable rather than merely readable. The temporary directory is
 * always removed, including when the restore throws.
 */
export function verifyBackupInTempDir({
  source,
  params,
  passphrase,
  tempRoot = os.tmpdir(),
}) {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'doubloom-verify-'));
  try {
    const restored = restoreNodeBackup({
      source,
      params,
      chainFile: path.join(directory, params.name, 'chain.json'),
      walletFile: path.join(directory, params.name, 'wallet.json'),
      passphrase,
    });
    return { height: restored.height, tip: restored.tip, keys: restored.keys };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Start the timer. `runNow` performs one backup and throws on failure; the
 * timer catches failures, logs them, and keeps the node running.
 *
 * `runBackup` writes and validates one archive. It may return a value or a
 * promise: the node passes a worker-thread runner so a long verification does
 * not block the event loop, while the CLI path stays in-process. The guards
 * (`stopped`, already running) are thrown synchronously either way.
 */
export function startBackupSchedule({
  params,
  chainFile,
  walletFile,
  directory,
  passphrase,
  intervalMs = DEFAULT_INTERVAL_MS,
  retention = DEFAULT_RETENTION,
  maxAgeMs = Math.max(intervalMs * DEFAULT_MAX_AGE_FACTOR, MIN_DEFAULT_MAX_AGE_MS),
  firstDelayMs = Math.min(DEFAULT_FIRST_DELAY_MS, intervalMs),
  firstMaxWaitMs = DEFAULT_FIRST_MAX_WAIT_MS,
  recoveryHistoryLimit = DEFAULT_RECOVERY_HISTORY_LIMIT,
  verifyIntervalMs = DEFAULT_VERIFY_INTERVAL_MS,
  verifyTempRoot = os.tmpdir(),
  firstReady = () => true,
  readyPollMs = 1000,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  statusFile = null,
  runBackup = (job) => createNodeBackup(job),
  verifyBackup = (job) => verifyBackupInTempDir(job),
  now = () => new Date(),
  log = (message) => console.log(message),
  logError = (message) => console.error(message),
} = {}) {
  if (!params || !chainFile || !walletFile || !directory) {
    throw new Error('automatic backups require a network, chain, wallet and directory');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('automatic backups require the wallet passphrase');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('backup interval must be a positive number of milliseconds');
  }
  const retentionLimits = normalizeRetention(retention);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('backup age limit must be a positive number of milliseconds');
  }
  if (!Number.isInteger(recoveryHistoryLimit) || recoveryHistoryLimit < 1) {
    throw new Error('recovery history depth must be a positive integer');
  }
  if (!Number.isFinite(verifyIntervalMs) || verifyIntervalMs < 0) {
    throw new Error(
      'backup verification interval must be zero or more milliseconds',
    );
  }
  if (typeof verifyBackup !== 'function') {
    throw new Error('backup verifier must be a function');
  }
  if (
    firstDelayMs !== null &&
    (!Number.isFinite(firstDelayMs) || firstDelayMs < 0)
  ) {
    throw new Error('first backup delay must be zero or a positive number of milliseconds');
  }
  if (!Number.isFinite(firstMaxWaitMs) || firstMaxWaitMs < 0) {
    throw new Error(
      'first backup wait limit must be zero or a positive number of milliseconds',
    );
  }
  if (!Number.isFinite(readyPollMs) || readyPollMs <= 0) {
    throw new Error('readiness poll interval must be a positive number of milliseconds');
  }
  if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    throw new Error('backup watchdog interval must be a positive number of milliseconds');
  }
  if (typeof runBackup !== 'function') {
    throw new Error('backup runner must be a function');
  }

  fs.mkdirSync(directory, { recursive: true });

  const statusPath = statusFile ?? backupStatusFile(chainFile);
  const persisted = loadBackupStatus({
    statusFile: statusPath,
    network: params.name,
  });
  let lastBackup = persisted?.lastBackup ?? null;
  let recoveryHistory = (persisted?.recoveryHistory ?? []).slice(
    0,
    recoveryHistoryLimit,
  );
  let lastRecovery = recoveryHistory[0] ?? persisted?.lastRecovery ?? null;
  let lastAttemptAt = persisted?.lastAttemptAt ?? null;
  let lastError = persisted?.lastError ?? null;

  let timer = null;
  let watchdog = null;
  let stopped = false;
  let running = false;
  let nextRunAt = null;
  let firstBackupPending = true;
  let waitingForSync = false;
  // When the readiness wait began: the first check that found sync unsettled.
  // Started there rather than at boot so the configured first delay is not
  // spent out of the cap.
  let firstWaitStartedAt = null;
  // One warning per stale episode, so a stalled schedule is not repeated on
  // every watchdog tick.
  let staleWarned = false;
  let verifying = false;
  let verifyTimer = null;
  // The archive that last failed verification. A corrupt file stays corrupt,
  // so the warning is reported once per archive rather than on every pass.
  let failedVerification = null;
  const schedulingEnabled = firstDelayMs !== null;

  function persistStatus() {
    saveBackupStatus(
      statusPath,
      {
        version: STATUS_VERSION,
        network: params.name,
        pid: process.pid,
        directory,
        firstDelayMs,
        firstMaxWaitMs,
        intervalMs,
        maxAgeMs,
        retention: retentionLimits,
        nextRunAt,
        waitingForSync,
        lastBackup,
        lastRecovery,
        recoveryHistory,
        recoveryHistoryLimit,
        lastAttemptAt,
        lastError,
      },
      logError,
    );
  }

  function finishRun(result) {
    // Measure the archive this run replaces: if it was already past the age
    // limit, writing a new one ends a stale episode, which is worth saying out
    // loud so the warning is not left standing as the last word.
    const previousAgeMs = lastBackup
      ? now().getTime() - Date.parse(lastBackup.at)
      : Number.NaN;
    const recoveredFromStale =
      Number.isFinite(previousAgeMs) && previousAgeMs > maxAgeMs;
    lastBackup = {
      at: lastAttemptAt,
      height: result.height,
      tip: result.tip,
      path: result.path,
      bytes: result.bytes,
      // The uncompressed size lets clients show how much the archive saved and
      // is what the explorer reports beside the compressed figure.
      rawBytes: result.rawBytes,
      keys: result.keys,
    };
    lastError = null;
    // A fresh archive ends any stale episode and re-arms the warning.
    staleWarned = false;
    const removed = pruneBackups({
      directory,
      network: params.name,
      retention: retentionLimits,
    });
    persistStatus();
    log(
      `backup written: ${path.basename(result.path)} (height ${result.height}, ${result.bytes} bytes)${
        removed.length > 0 ? `; removed ${removed.length} old backup(s)` : ''
      }`,
    );
    if (recoveredFromStale) {
      log(
        `backup schedule recovered: the previous archive was ${formatDuration(previousAgeMs)} old, past the ${formatDuration(maxAgeMs)} limit; fresh archives are being written again (height ${result.height})`,
      );
    }
    return result;
  }

  function failRun(error) {
    lastError = error.message;
    persistStatus();
    throw error;
  }

  function runNow() {
    if (stopped) {
      throw new Error('backup schedule is stopped');
    }
    if (running) {
      throw new Error('a backup is already running');
    }

    running = true;
    const at = now();
    lastAttemptAt = at.toISOString();

    let pending;
    try {
      const destination = nextPath(directory, params.name, at);
      pending = runBackup({
        params,
        chainFile,
        walletFile,
        destination,
        passphrase,
      });
    } catch (error) {
      running = false;
      return failRun(error);
    }

    if (isThenable(pending)) {
      // A worker-thread backup: the node keeps serving while it runs, and the
      // `running` guard rejects a second request until this one settles.
      return pending.then(
        (result) => {
          running = false;
          return finishRun(result);
        },
        (error) => {
          running = false;
          return failRun(error);
        },
      );
    }

    running = false;
    return finishRun(pending);
  }

  function schedule(delay = intervalMs) {
    if (stopped) {
      return;
    }
    nextRunAt = new Date(now().getTime() + delay).toISOString();
    timer = setTimeout(tick, delay);
    timer?.unref?.();
    persistStatus();
  }

  /**
   * Warn once when the newest archive is older than `maxAgeMs`. Before the
   * first backup of this process there is nothing meaningful to compare: the
   * schedule may legitimately be waiting for sync or for its first delay.
   */
  function checkStaleness() {
    if (stopped || !schedulingEnabled || running || firstBackupPending) {
      return false;
    }
    if (!lastBackup) {
      return false;
    }

    const ageMs = now().getTime() - Date.parse(lastBackup.at);
    if (!Number.isFinite(ageMs) || ageMs <= maxAgeMs) {
      staleWarned = false;
      return false;
    }

    if (!staleWarned) {
      staleWarned = true;
      logError(
        `warning: the last automatic backup is ${formatDuration(ageMs)} old, past the ${formatDuration(maxAgeMs)} limit; automatic backups may have stopped`,
      );
    }
    return true;
  }

  /**
   * Restore the newest archive into a temporary directory and check it came
   * back. This is the only way to find out that an archive is unusable: the
   * bytes can be present, gzip-readable and still fail to replay or unlock.
   */
  function verifyNewest() {
    // A write in flight owns the newest path, and one check at a time is enough.
    if (stopped || verifying || running || !lastBackup?.path) {
      return null;
    }

    const archive = lastBackup;
    const name = path.basename(archive.path);
    verifying = true;

    const settle = (error, restored) => {
      verifying = false;
      let problem = null;
      if (error) {
        problem = `warning: the newest backup could not be verified: ${name} (${error.message}); the archive may be corrupt or the wallet passphrase may have changed`;
      } else if (
        Number.isFinite(restored?.height) &&
        Number.isFinite(archive.height) &&
        restored.height !== archive.height
      ) {
        problem = `warning: backup verification restored ${name} at height ${restored.height}, but the record says ${archive.height}`;
      }

      if (problem) {
        if (failedVerification !== archive.path) {
          failedVerification = archive.path;
          logError(problem);
        }
        return;
      }

      if (failedVerification === archive.path) {
        // The archive that failed now restores, so say so instead of leaving
        // the warning as the last word.
        failedVerification = null;
        log(`backup verification recovered: ${name} now restores cleanly`);
      }
      log(
        `backup verified: ${name} restored to a temporary directory (height ${
          restored?.height ?? archive.height
        })`,
      );
    };

    let pending;
    try {
      pending = verifyBackup({
        source: archive.path,
        params,
        passphrase,
        tempRoot: verifyTempRoot,
      });
    } catch (error) {
      settle(error);
      return false;
    }

    if (isThenable(pending)) {
      // A worker-thread restore: the node keeps serving while the archive is
      // replayed, and the result arrives as a promise.
      pending.then(
        (restored) => settle(null, restored),
        (error) => settle(error),
      );
      return pending;
    }

    settle(null, pending);
    return true;
  }

  function ensureScheduled() {
    if (stopped || !schedulingEnabled || running) {
      return false;
    }
    checkStaleness();
    if (nextRunAt && timer) {
      return false;
    }

    const hadNextRun = Boolean(nextRunAt);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const recoveredAt = now();
    const delay = backupRecoveryDelayMs({
      nowMs: recoveredAt.getTime(),
      lastBackupAt: lastBackup?.at,
      intervalMs,
      firstDelayMs,
      firstBackupPending,
    });
    const catchingUp = !firstBackupPending && delay === 0;
    const reason = `${
      hadNextRun ? 'timer was missing' : 'next run was missing'
    }${catchingUp ? '; archive overdue, catching up now' : ''}`;
    lastRecovery = { at: recoveredAt.toISOString(), reason };
    recoveryHistory = [lastRecovery, ...recoveryHistory].slice(
      0,
      recoveryHistoryLimit,
    );
    schedule(delay);
    log(`Automatic backup schedule re-armed (${reason}): ${nextRunAt}`);
    return true;
  }

  function tick() {
    timer = null;
    if (stopped) {
      return;
    }

    if (firstBackupPending) {
      let ready = false;
      try {
        ready = Boolean(firstReady());
      } catch (error) {
        logError(`could not check first-backup readiness: ${error.message}`);
      }
      if (!ready) {
        if (firstWaitStartedAt === null) {
          firstWaitStartedAt = now().getTime();
        }
        const waitedMs = now().getTime() - firstWaitStartedAt;
        if (firstMaxWaitMs === 0 || waitedMs < firstMaxWaitMs) {
          waitingForSync = true;
          schedule(readyPollMs);
          return;
        }
        // A peer that never answers must not hold the first archive hostage:
        // an archive of the chain as it stands is worth more than none at all.
        log(
          `First automatic backup: peer sync has not settled after ${formatDuration(waitedMs)} (limit ${formatDuration(firstMaxWaitMs)}); writing an archive anyway`,
        );
      }
      waitingForSync = false;
      firstBackupPending = false;
    }

    nextRunAt = null;
    persistStatus();

    let pending;
    try {
      pending = runNow();
    } catch (error) {
      logError(`automatic backup failed: ${error.message}`);
      schedule();
      return;
    }

    if (isThenable(pending)) {
      // The archive is being written and validated on a worker thread; the
      // next run is scheduled only once that finishes, so ticks cannot pile up.
      pending.then(
        () => schedule(),
        (error) => {
          logError(`automatic backup failed: ${error.message}`);
          schedule();
        },
      );
      return;
    }

    schedule();
  }

  if (schedulingEnabled) {
    schedule(firstDelayMs);
  } else {
    // No timer exists; clear any next-run time left by a previous process.
    nextRunAt = null;
    persistStatus();
  }

  if (schedulingEnabled) {
    watchdog = setInterval(ensureScheduled, watchdogMs);
    watchdog.unref?.();
    if (verifyIntervalMs > 0) {
      verifyTimer = setInterval(verifyNewest, verifyIntervalMs);
      verifyTimer.unref?.();
    }
  }

  return {
    directory,
    intervalMs,
    retention: retentionLimits,
    statusFile: statusPath,
    verifyIntervalMs,
    runNow,
    verifyNow: verifyNewest,
    ensureScheduled,
    status() {
      return {
        enabled: true,
        directory,
        firstDelayMs,
        firstMaxWaitMs,
        intervalMs,
        maxAgeMs,
        retention: retentionLimits,
        statusFile: statusPath,
        verifyIntervalMs,
        nextRunAt,
        running,
        verifying,
        waitingForSync,
        // How long the first backup has been held back by peer sync, so a
        // client can show a wait rather than only a state. Null unless a wait
        // is in progress; the timestamp lets a client tick the figure itself
        // between refreshes instead of watching it jump every poll.
        syncWaitStartedAt:
          waitingForSync && firstWaitStartedAt !== null
            ? new Date(firstWaitStartedAt).toISOString()
            : null,
        syncWaitedMs:
          waitingForSync && firstWaitStartedAt !== null
            ? Math.max(0, now().getTime() - firstWaitStartedAt)
            : null,
        lastBackup,
        lastRecovery,
        recoveryHistory,
        recoveryHistoryLimit,
        lastAttemptAt,
        lastError,
      };
    },
    stop() {
      stopped = true;
      nextRunAt = null;
      waitingForSync = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
      if (verifyTimer) {
        clearInterval(verifyTimer);
        verifyTimer = null;
      }
      persistStatus();
    },
  };
}
