#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { MAX_MONEY, NETWORKS, networkParams } from './params.js';
import { Chain, subsidyAt } from './chain.js';
import { Wallet, backupArchiveTime } from './wallet.js';
import { loadChain, saveChain } from './store.js';
import { formatAmount } from './amount.js';
import { headerHash, mineHeader } from './block.js';
import { txid } from './transaction.js';
import { decodeAddress } from './keys.js';
import { readPassphrase } from './passphrase.js';
import { assertPassphrase } from './wallet-crypto.js';
import { createNodeBackup, restoreNodeBackup } from './backup.js';
import {
  backupAgeMs,
  backupMaxAgeMs,
  backupStatusFile,
  backupVerdict,
  listArchives,
  loadBackupStatus,
  normalizeRetention,
  retentionAssignments,
} from './backup-scheduler.js';
import { loadNodeState, nodeStateFile } from './node-state.js';
import { formatWork } from './work-format.js';

const GOLD = '\x1b[38;5;214m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function usage() {
  console.log(`
${GOLD}${BOLD}Doubloom (Đ)${RESET} — a Bitcoin-style cryptocurrency

${BOLD}Usage${RESET}
  doubloom <command> [options]

${BOLD}Commands${RESET}
  init                       Create the genesis chain and a wallet
  info [--json]              Chain, supply and wallet summary
  address                    Show the wallet's receiving address
  balance [address]          Confirmed and spendable balance
  send <address> <amount>    Sign a transaction into the mempool
  mempool                    List pending transactions
  mine [--blocks N]          Mine blocks to a wallet address
  mining [status|pause|resume]
                             Show or change mining on a running node
                             (status also takes --json)
  blocks [--limit N]         List recent blocks
  block <height|hash>        Show one block
  tx <txid>                  Show a transaction
  validate                   Re-validate the entire chain
  backup <file>              Back up the chain and encrypted wallet
  backup now [--to <path>]   Ask a running node to back up immediately, or to
                             write an export to <path> outside its backup
                             directory
  backup list                List archives with their size and the retention
                             tier that keeps each one
  backup status [--json] [--watch]
                             Show automatic backup status (--watch redraws it
                             while the node runs)
  restore <file>             Restore the chain and wallet from a backup
  wallet new [--label L]     Add a key to the wallet
  wallet list                List wallet addresses
  wallet lock                Encrypt private keys with a passphrase
  wallet passphrase          Change the passphrase in place
  wallet unlock              Decrypt the wallet to plaintext on disk
  wallet backup <file>       Write a verified encrypted wallet copy (.gz)
  wallet restore <file>      Restore a wallet from an encrypted backup
  node                       Run a P2P node and block explorer

${BOLD}Options${RESET}
  --network <name>           ${Object.keys(NETWORKS).join(' | ')} (default mainnet)
  --datadir <path>           Data directory (default ./data)
  --address <address>        Payout address for mining / node
  --from <address>           Wallet address to spend from
  --fee-rate <petals/byte>   Fee rate (default ${networkParams('mainnet').minFeeRate})
  --port <port>              Node API port (default 8338 mainnet, 18338 devnet)
  --url <url>                Node API origin for "mining" instead of --port
                             (default http://127.0.0.1:<port>)
  --host <host>              Node bind address (default 127.0.0.1)
  --announce <host[:port]>   Address peers should use to reach this node
  --announce-interface <name>
                             Take the announced address from this network
                             interface (e.g. eth0, en0) instead of the first
                             routable one
  --peers <url,url>          Comma-separated peer nodes
  --seed <host[:port],...>   DNS seeds to resolve for peer discovery
  --no-seed                  Ignore all DNS seeds
  --log-level <level>        full | blocks | quiet (default full): "blocks"
                             drops the per-transaction lines, "quiet" keeps
                             only warnings and errors
  --mine                     Mine while running the node
  --backup-dir <path>        Write verified backups while the node runs
  --backup-first-delay <sec> Seconds before the first backup (default 10)
  --backup-first-max-wait <sec>
                             How long the first backup waits for peer sync
                             to settle before writing anyway (default 300,
                             0 waits indefinitely)
  --backup-interval <min>    Minutes between automatic backups (default 60)
  --backup-keep-hourly <n>   Hourly archives to retain (default 24)
  --backup-keep-daily <n>    Daily archives to retain (default 7)
  --backup-keep-weekly <n>   Weekly archives to retain (default 4)
  --backup-max-age <min>     Warn when the last backup is older than this
                             (default twice the interval, at least 1 min)
  --backup-max-lag <blocks>  Flag an archive this many blocks behind the tip
                             (default the blocks in one interval: 6 for an
                             hourly schedule at 10-minute spacing)
  --backup-verify-interval <min>
                             Restore the newest archive to a temporary
                             directory this often (default 360, 0 disables)
  --backup-recovery-history <count>
                             Recovery events to retain (default 5)
  --label <text>             Label for a new wallet key
  --force                    Overwrite existing data on restore
  --json                     Machine-readable output for info, backup status
                             and mining status
  --watch                    Keep "backup status" on screen, refreshing once
                             a second until the node stops

${BOLD}Passphrase${RESET}
  Signing commands prompt for the wallet passphrase when the wallet is
  encrypted. "wallet passphrase" re-encrypts the keys under a new one.
  For scripts, set DOUBLOOM_PASSPHRASE instead of typing it.

${BOLD}Examples${RESET}
  doubloom init
  doubloom mine --blocks 101
  doubloom send D... 2.5
  doubloom node --mine
  doubloom node --mine --backup-dir backups
  doubloom wallet backup wallet-backup.json     (writes wallet-backup.json.gz)
  doubloom backup node-backup.json      (writes node-backup.json.gz)
  doubloom --network devnet init
`);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const [name, inline] = argument.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (
        argv[index + 1] !== undefined &&
        !argv[index + 1].startsWith('--')
      ) {
        flags[name] = argv[index + 1];
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(argument);
    }
  }

  return { flags, positional };
}

function context(flags) {
  const params = networkParams(
    String(flags.network ?? process.env.DOUBLOOM_NETWORK ?? 'mainnet'),
  );
  const datadir = path.resolve(
    String(flags.datadir ?? process.env.DOUBLOOM_DATA ?? 'data'),
  );
  const dir = path.join(datadir, params.name);
  return {
    params,
    datadir,
    dir,
    chainFile: path.join(dir, 'chain.json'),
    walletFile: path.join(dir, 'wallet.json'),
  };
}

function openChain(ctx, { create = false } = {}) {
  let chain = loadChain(ctx.params, ctx.chainFile);
  if (!chain) {
    if (!create) {
      throw new Error(
        `no ${ctx.params.name} chain in ${ctx.dir}. Run "doubloom init" first.`,
      );
    }
    chain = Chain.create(ctx.params);
    saveChain(chain, ctx.chainFile);
  }
  return chain;
}

function openWallet(ctx, { create = false } = {}) {
  let wallet = Wallet.load(ctx.walletFile, ctx.params);
  if (!wallet && create) {
    wallet = Wallet.create(ctx.walletFile, ctx.params);
  }
  return wallet;
}

function timestamp(seconds) {
  return `${new Date(seconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)} UTC`;
}

function row(label, value) {
  console.log(`  ${DIM}${label.padEnd(16)}${RESET}${value}`);
}

function isoTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return timestamp(Math.floor(date.getTime() / 1000));
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this account cannot signal it.
    return error.code === 'EPERM';
  }
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '—';
  }
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const minutes = milliseconds / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

/** "keep hourly 24 · daily 7 · weekly 4", omitting tiers that are off. */
function retentionSummary(retention) {
  if (!retention) {
    return 'keep unknown';
  }
  const parts = ['hourly', 'daily', 'weekly']
    .filter((tier) => Number.isInteger(retention[tier]) && retention[tier] > 0)
    .map((tier) => `${tier} ${retention[tier]}`);
  return parts.length > 0 ? `keep ${parts.join(' · ')}` : 'keep nothing';
}

function timeFromNow(iso) {
  const delta = Date.parse(iso) - Date.now();
  if (!Number.isFinite(delta)) {
    return 'unknown';
  }
  if (delta <= 0) {
    return 'due now';
  }
  // Two units, so a countdown is readable rather than rounded away: "in 52m
  // 10s" is useful where "in 1h" would hide the difference between 5 and 55
  // minutes.
  const seconds = Math.ceil(delta / 1000);
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds ? `in ${minutes}m ${restSeconds}s` : `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes ? `in ${hours}h ${restMinutes}m` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `in ${days}d ${restHours}h` : `in ${days}d`;
}

/**
 * Follow a backup job until the node reports it settled. The node answers the
 * request immediately with an id, because the archive is written and verified
 * in the background; polling is what turns that back into a blocking command.
 */
/**
 * The percentage of a running backup, as `42% verified (420/1,000 blocks)`, or
 * null when the node has not reported a figure yet — an older node reports none
 * at all, and the caller then falls back to elapsed time alone.
 */
function backupProgressText(progress) {
  if (!progress || !Number.isInteger(progress.percent)) {
    return null;
  }
  const phase = progress.phase === 'verifying' ? 'verified' : 'written';
  const counts =
    Number.isInteger(progress.done) &&
    Number.isInteger(progress.total) &&
    progress.total > 0
      ? ` (${progress.done.toLocaleString()}/${progress.total.toLocaleString()} blocks)`
      : '';
  return `${progress.percent}% ${phase}${counts}`;
}

async function waitForBackupJob(nodeUrl, id) {
  const started = Date.now();
  // Writing and verifying a large archive keeps the node busy for seconds and
  // says nothing meanwhile. A terminal gets one line rewritten in place, so the
  // wait reads as a clock; a pipe (a log file, CI) gets a line every five
  // seconds rather than a stream of carriage returns.
  const interactive = Boolean(process.stdout.isTTY);
  const everyMs = interactive ? 1000 : 5000;
  let printed = false;
  let nextProgressAt = started + everyMs;
  try {
    for (;;) {
      let response;
      try {
        response = await fetch(
          `${nodeUrl}/api/backup/jobs/${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(10_000) },
        );
      } catch {
        throw new Error(
          `lost contact with ${nodeUrl} while backup job ${id} was running; check "doubloom backup status"`,
        );
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) {
        throw new Error(
          `the node at ${nodeUrl} does not expose /api/backup/jobs; update it`,
        );
      }
      if (!response.ok) {
        throw new Error(
          payload.error ?? `node returned HTTP ${response.status}`,
        );
      }
      const job = payload.job;
      if (!job) {
        throw new Error('the node returned no backup job');
      }
      if (job.state !== 'running') {
        return job;
      }
      if (Date.now() >= nextProgressAt) {
        // The node counts the blocks it has written and then re-verified, so
        // the percentage is measured work rather than an estimate. A node too
        // old to report any leaves the line as elapsed time alone.
        const seconds = Math.round((Date.now() - started) / 1000);
        const detail = backupProgressText(job.progress);
        const line = detail
          ? `waiting for the node · ${detail} · ${seconds}s`
          : `waiting for the node to write and verify the archive · ${seconds}s`;
        if (interactive) {
          process.stdout.write(`\r${DIM}${line}${RESET}\x1b[K`);
        } else {
          console.log(line);
        }
        printed = true;
        nextProgressAt = Date.now() + everyMs;
      }
      if (Date.now() - started > 300_000) {
        throw new Error(
          `backup job ${id} did not finish within five minutes; check "doubloom backup status"`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    // Leave the progress line behind before the report starts, so the table is
    // not printed on top of it. A piped run has already printed whole lines.
    if (printed && interactive) {
      process.stdout.write('\r\x1b[K');
    }
  }
}

/**
 * Ask a node on this machine whether its miner is running. The node records the
 * port it bound, so `doubloom info` can report the live miner state in the same
 * command as the chain summary. `null` means the node did not answer — it may
 * be bound to an interface this machine cannot reach over loopback — which is
 * not the same as a miner that is paused.
 */
async function nodeMiningState(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/mining`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return typeof payload.mining === 'boolean' ? payload.mining : null;
  } catch {
    return null;
  }
}

/**
 * Where `doubloom mining` sends its requests: the loopback port by default, or
 * an explicit `--url` for a node on another machine. Such a node only answers
 * if it was started with `--host 0.0.0.0` or sits behind a proxy, since the API
 * binds to loopback otherwise.
 */
function miningNodeUrl(ctx, flags) {
  if (flags.url !== undefined) {
    if (flags.port !== undefined) {
      throw new Error('pass either --url or --port for the node, not both');
    }
    if (flags.url === true) {
      throw new Error('--url requires a URL, e.g. --url http://10.0.0.5:18338');
    }
    const text = String(flags.url).trim();
    let parsed = null;
    try {
      parsed = new URL(text);
    } catch {
      parsed = null;
    }
    // Only the origin is meaningful: the API calls below would silently drop a
    // path, a query string or credentials, so reject them instead.
    if (
      !parsed ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      throw new Error(
        `--url must be a plain http(s) origin, e.g. http://10.0.0.5:18338 (got "${text}")`,
      );
    }
    return `${parsed.protocol}//${parsed.host}`;
  }

  if (flags.port !== undefined && typeof flags.port !== 'string') {
    throw new Error(
      '--port requires a number, e.g. "doubloom mining status --port 8338"',
    );
  }
  const port = Number(flags.port ?? ctx.params.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be a number between 1 and 65535');
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Ask a running node to write and verify a backup now, through the same
 * `POST /api/backup` route the explorer's button uses. The archive is written
 * and validated by the node's own worker thread; this only waits for the job it
 * hands back, never touching the data directory itself.
 */
async function triggerNodeBackup(ctx, flags) {
  // A node started on a non-default port records it next to the chain, so an
  // operator who forgets --port still reaches the node they are looking at.
  const state = loadNodeState({
    stateFile: nodeStateFile(ctx.chainFile),
    network: ctx.params.name,
  });
  const recorded =
    flags.port === undefined &&
    Number.isInteger(state?.port) &&
    processIsRunning(state.pid)
      ? state.port
      : null;
  const port = Number(flags.port ?? recorded ?? ctx.params.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be a number between 1 and 65535');
  }
  const nodeUrl = `http://127.0.0.1:${port}`;

  // Resolved here rather than taken as typed: the node reads its own working
  // directory, and an operator at a shell expects a relative path to mean the
  // one they are standing in.
  const destination =
    flags.to === undefined ? null : path.resolve(String(flags.to));

  // A plain run sends no body at all, so a node that predates exports sees the
  // same request it always did; only an export needs one.
  const request = {
    method: 'POST',
    // The node answers as soon as the job is queued; the wait happens below.
    signal: AbortSignal.timeout(30_000),
  };
  if (destination) {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify({ destination });
  }

  let response;
  try {
    response = await fetch(`${nodeUrl}/api/backup`, request);
  } catch {
    throw new Error(
      `no node answering at ${nodeUrl}; start one with "doubloom node" or pass --port`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw new Error(
      `the node at ${nodeUrl} does not expose /api/backup; update it`,
    );
  }
  if (response.status === 409 && /not enabled/.test(payload.error ?? '')) {
    throw new Error(
      `the node at ${nodeUrl} has no backup directory; restart it with --backup-dir <path>`,
    );
  }
  if (!response.ok || !payload.job) {
    throw new Error(payload.error ?? `node returned HTTP ${response.status}`);
  }

  const job = await waitForBackupJob(nodeUrl, payload.job.id);
  if (job.state !== 'succeeded' || !job.backup) {
    throw new Error(job.error ?? 'the node reported the backup failed');
  }
  // Read the schedule again: the status sent with the request predates this run.
  const schedule = await fetch(`${nodeUrl}/api/backup`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((answer) => (answer.ok ? answer.json() : null))
    .catch(() => null);

  const backup = job.backup;
  console.log(`\n${GOLD}Backup written and verified on the node${RESET}\n`);
  row('node', nodeUrl);
  row('job', job.id);
  row('file', backup.path);
  row(
    'size',
    `${Number(backup.bytes).toLocaleString()} bytes gzipped ${DIM}(from ${Number(
      backup.rawBytes,
    ).toLocaleString()})${RESET}`,
  );
  row('height', Number(backup.height).toLocaleString());
  row('tip', backup.tip);
  row('keys', String(backup.keys));
  if (backup.at) {
    row('at', isoTimestamp(backup.at));
  }
  if (schedule?.nextRunAt) {
    row(
      'next run',
      `${isoTimestamp(schedule.nextRunAt)} ${DIM}(${timeFromNow(
        schedule.nextRunAt,
      )})${RESET}`,
    );
  }
  console.log(
    destination
      ? `\n${DIM}The archive holds every confirmed block and the encrypted wallet;\nthis export sits outside the node's backup directory, where retention\nwill never remove it.${RESET}\n`
      : `\n${DIM}The archive holds every confirmed block and the encrypted wallet,\nand stays in the node's backup directory under its retention rules.${RESET}\n`,
  );
}

/** The chain's height, or null when there is no chain file to read. */
function chainHeightOrNull(ctx) {
  try {
    const chain = loadChain(ctx.params, ctx.chainFile);
    return chain ? chain.height : null;
  } catch {
    return null;
  }
}

/**
 * The backup record as plain data: exactly what the status file holds, plus the
 * owning process's liveness, where the record came from, and one computed
 * verdict, so a script does not have to reimplement the running-pid check or the
 * age and lag rules.
 *
 * `nextRunAt` is null unless the recorded node is alive. A status file left
 * behind by an exited node still carries the timestamp it intended, but that
 * run will never happen, and a script scheduling around it would wait forever.
 */
function backupStatusPayload(ctx) {
  const statusFile = backupStatusFile(ctx.chainFile);
  const configured = fs.existsSync(statusFile);
  const status = configured
    ? loadBackupStatus({
        statusFile,
        network: ctx.params.name,
      })
    : null;
  if (configured && !status) {
    throw new Error(
      `backup status at ${statusFile} is unreadable or belongs to another network`,
    );
  }

  const running = Boolean(status?.pid && processIsRunning(status.pid));
  // The lag rule needs the chain the archive is supposed to represent; without
  // a chain file there is nothing to compare against, so only age decides.
  const tipHeight = chainHeightOrNull(ctx);
  const nowMs = Date.now();

  return {
    network: ctx.params.name,
    statusFile,
    configured: Boolean(status),
    running,
    // One word a script can branch on instead of re-deriving the age and lag
    // rules: healthy, stale, behind, failed, waiting or unknown.
    verdict: backupVerdict({ status, tipHeight, nowMs }),
    // How old the newest archive is, measured once so it is the same age the
    // verdict above was reached from, and null when there is no archive.
    lastArchiveAgeMs: backupAgeMs(status, nowMs),
    tipHeight,
    pid: status?.pid ?? null,
    directory: status?.directory ?? null,
    intervalMs: status?.intervalMs ?? null,
    firstDelayMs: status?.firstDelayMs ?? null,
    firstMaxWaitMs: status?.firstMaxWaitMs ?? null,
    maxAgeMs: status?.maxAgeMs ?? null,
    maxLagBlocks: status?.maxLagBlocks ?? null,
    retention: status?.retention ?? null,
    recoveryHistoryLimit: status?.recoveryHistoryLimit ?? null,
    nextRunAt: running ? (status?.nextRunAt ?? null) : null,
    waitingForSync: running && Boolean(status?.waitingForSync),
    lastAttemptAt: status?.lastAttemptAt ?? null,
    lastError: status?.lastError ?? null,
    lastBackup: status?.lastBackup ?? null,
    maxArchiveAgeMs: status ? backupMaxAgeMs(status) : null,
    lastRecovery: status?.lastRecovery ?? null,
    recoveryHistory: status?.recoveryHistory ?? [],
    archives: retainedArchiveEntries(status, ctx.params.name),
  };
}

/**
 * The archives retention keeps, newest first, with how long each took to write.
 * The schedule records both ends of every write it performs, and those are used
 * first; an archive from before that record existed falls back to what is on
 * disk — the name for the attempt, the file's last write for the finish.
 */
function retainedArchiveEntries(status, network) {
  if (!status?.directory) {
    return [];
  }
  const archives = listArchives({
    directory: status.directory,
    network,
    writes: status.archiveWrites ?? null,
  });
  const kept = retentionAssignments(
    archives,
    status.retention ?? normalizeRetention(),
  );
  return archives
    .filter((archive) => kept.has(archive.name))
    .map((archive) => ({
      name: archive.name,
      at: archive.at,
      // The two ends the duration comes from, so a script does not have to
      // subtract `writeMs` from the archive time itself.
      startedAt: archive.startedAt ?? null,
      finishedAt: archive.finishedAt ?? null,
      bytes: archive.bytes,
      writeMs: archive.writeMs ?? null,
    }));
}

/** How long ago a timestamp was, in the same two-unit style as `timeFromNow`. */
function timeAgo(iso) {
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) {
    return 'unknown';
  }
  const seconds = Math.floor(Math.max(0, delta) / 1000);
  if (seconds < 1) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds ? `${minutes}m ${restSeconds}s ago` : `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes ? `${hours}h ${restMinutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h ago` : `${days}d ago`;
}

/**
 * The backup panel as plain lines, so the one-shot command can print it and
 * `--watch` can redraw the same text in place. Rendering is the only thing the
 * two modes share; neither owns a copy of the wording.
 */
function backupStatusLines(ctx) {
  const lines = [];
  const emit = (label, value) => {
    lines.push(`  ${DIM}${label.padEnd(16)}${RESET}${value}`);
  };

  const file = backupStatusFile(ctx.chainFile);
  const status = loadBackupStatus({
    statusFile: file,
    network: ctx.params.name,
  });

  lines.push('', `${BOLD}Automatic backups${RESET}`, '');
  if (!fs.existsSync(file)) {
    emit('status', 'not configured');
    lines.push(
      '',
      `${DIM}Start a node with --backup-dir to enable automatic backups.${RESET}`,
      '',
    );
    return lines;
  }
  if (!status) {
    throw new Error(
      `backup status at ${file} is unreadable or belongs to another network`,
    );
  }

  const running = processIsRunning(status.pid);
  emit(
    'node',
    status.pid
      ? `${running ? `${GOLD}running${RESET}` : 'not running'} ${DIM}pid ${status.pid}${RESET}`
      : `${DIM}unknown owner${RESET}`,
  );
  emit(
    'schedule',
    status.intervalMs === null
      ? 'unknown'
      :          `every ${formatDuration(status.intervalMs)} · ${retentionSummary(
            status.retention,
          )} · recoveries ${status.recoveryHistoryLimit ?? 5}${
            Number.isFinite(status.maxAgeMs)
              ? ` · max age ${formatDuration(status.maxAgeMs)}`
              : ''
          }${
            Number.isInteger(status.maxLagBlocks)
              ? ` · lag ${status.maxLagBlocks} block${
                  status.maxLagBlocks === 1 ? '' : 's'
                }`
              : ''
          }`
  );
  if (status.directory) {
    emit('directory', status.directory);
  }

  const firstDelay = Number.isFinite(status.firstDelayMs)
    ? ` · first delay ${formatDuration(status.firstDelayMs)}`
    : '';
  // Only shown when the wait is actually capped; zero means "however long it
  // takes", which is worth saying rather than showing a meaningless limit.
  const firstWait =
    Number.isFinite(status.firstMaxWaitMs) && status.firstMaxWaitMs > 0
      ? ` · sync wait cap ${formatDuration(status.firstMaxWaitMs)}`
      : Number.isFinite(status.firstMaxWaitMs)
        ? ' · sync wait uncapped'
        : '';
  if (status.nextRunAt && running) {
    emit(
      'next run',
      `${isoTimestamp(status.nextRunAt)} ${DIM}(${
        status.waitingForSync ? 'waiting for sync' : timeFromNow(status.nextRunAt)
      })${RESET}${firstDelay}${firstWait}`,
    );
  } else {
    emit(
      'next run',
      `${running ? 'not scheduled' : `${DIM}not scheduled (node not running)${RESET}`}${firstDelay}${firstWait}`,
    );
  }

  const recoveryHistory = status.recoveryHistory?.length
    ? status.recoveryHistory
    : status.lastRecovery
      ? [status.lastRecovery]
      : [];
  emit(
    'last recovery',
    recoveryHistory.length > 0
      ? `${isoTimestamp(recoveryHistory[0].at)} ${DIM}(${timeAgo(
          recoveryHistory[0].at,
        )})${RESET} · ${recoveryHistory[0].reason}`
      : 'none',
  );
  for (const recovery of recoveryHistory.slice(1)) {
    emit(
      'earlier',
      `${isoTimestamp(recovery.at)} ${DIM}(${timeAgo(recovery.at)})${RESET} · ${recovery.reason}`,
    );
  }

  if (status.lastBackup) {
    const last = status.lastBackup;
    // Both sizes when the node recorded them: what the file costs on disk and
    // what it holds, which is what makes the gzip saving meaningful.
    const savedPercent =
      Number.isFinite(last.rawBytes) && last.rawBytes > last.bytes
        ? Math.round((1 - last.bytes / last.rawBytes) * 100)
        : null;
    const size = Number.isFinite(last.bytes)
      ? ` · ${last.bytes.toLocaleString()} bytes${
          savedPercent === null
            ? ''
            : ` gzipped (from ${last.rawBytes.toLocaleString()} raw, ${savedPercent}% smaller)`
        }`
      : '';
    const keys = Number.isFinite(last.keys)
      ? ` · ${last.keys} key${last.keys === 1 ? '' : 's'}`
      : '';
    emit(
      'last archive',
      `${isoTimestamp(last.at)} ${DIM}(${timeAgo(last.at)})${RESET} · height ${last.height.toLocaleString()}${size}${keys}`,
    );
    emit('archive', last.path);
  } else {
    emit('last archive', 'none yet');
  }

  // Every archive retention keeps, with the time it took to write. The newest
  // appears above too, but a list is what makes the older ones comparable.
  for (const archive of retainedArchiveEntries(status, ctx.params.name)) {
    emit(
      'retained',
      `${isoTimestamp(archive.at)} · ${formatFileSize(archive.bytes)}${
        archive.writeMs === null
          ? ` ${DIM}· write time not recorded${RESET}`
          : ` · wrote in ${formatWriteDuration(archive.writeMs)}`
      }`,
    );
  }

  if (status.lastError) {
    emit('last error', `${RED}${status.lastError}${RESET}`);
    if (status.lastAttemptAt) {
      emit(
        'attempted',
        `${isoTimestamp(status.lastAttemptAt)} ${DIM}(${timeAgo(
          status.lastAttemptAt,
        )})${RESET}`,
      );
    }
  } else {
    emit(
      'last attempt',
      status.lastAttemptAt
        ? `${isoTimestamp(status.lastAttemptAt)} ${DIM}(${timeAgo(
            status.lastAttemptAt,
          )})${RESET}`
        : 'none yet',
    );
    emit('last error', 'none');
  }

  emit('status file', file);
  lines.push('');
  return lines;
}

function printBackupStatus(ctx) {
  for (const line of backupStatusLines(ctx)) {
    console.log(line);
  }
}

/** `2026-10-31 06:19:06.827` — a UTC stamp that keeps archive names distinct. */
function utcStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * A write duration: milliseconds below a second, because an archive of a small
 * chain is written in tens of milliseconds and "0.0s" would say nothing.
 */
function formatWriteDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return '—';
  }
  if (milliseconds < 1000) {
    return `${Math.max(1, Math.round(milliseconds))}ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  return formatDuration(milliseconds);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes.toLocaleString()} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * `doubloom backup list`: every archive on disk with its size and the retention
 * tiers that keep it. The directory comes from `--backup-dir` or from the
 * schedule the node recorded, so a stopped node's archives can be inspected
 * without starting it again.
 *
 * An archive no tier selects is listed as prunable rather than hidden: it exists
 * right now, and the next run is what removes it.
 */
function printBackupArchives(ctx, flags) {
  const status = loadBackupStatus({
    statusFile: backupStatusFile(ctx.chainFile),
    network: ctx.params.name,
  });
  const requested = flags['backup-dir'] ?? status?.directory;
  if (!requested) {
    throw new Error(
      'no backup directory known; pass --backup-dir <path> or start a node with --backup-dir',
    );
  }

  const directory = path.resolve(String(requested));
  // The recorded schedule is the retention actually in force; a directory with
  // no schedule beside it is judged by the defaults the node would use.
  const retention = status?.retention ?? normalizeRetention();
  const archives = listArchives({ directory, network: ctx.params.name });
  const assignments = retentionAssignments(archives, retention);

  console.log(`\n${BOLD}Archives${RESET} ${DIM}${directory} · times UTC${RESET}\n`);
  if (archives.length === 0) {
    row('status', 'no archives yet');
    console.log(
      `\n${DIM}A node started with --backup-dir writes them on its schedule.${RESET}\n`,
    );
    return;
  }

  const stamps = archives.map((archive) => utcStamp(archive.at));
  const width = Math.max(...stamps.map((stamp) => stamp.length));
  archives.forEach((archive, index) => {
    const tiers = assignments.get(archive.name);
    const kept = tiers?.length
      ? tiers.join(' · ')
      : `${DIM}prunable${RESET}`;
    console.log(
      `  ${stamps[index].padEnd(width)}  ${formatFileSize(archive.bytes).padStart(9)}  ${kept}`,
    );
  });

  const total = archives.reduce(
    (sum, archive) => sum + (Number.isFinite(archive.bytes) ? archive.bytes : 0),
    0,
  );
  console.log(
    `\n  ${DIM}${archives.length} archive${archives.length === 1 ? '' : 's'} · ${formatFileSize(total)} total · ${retentionSummary(retention)}; archives no tier keeps are pruned after the next backup${RESET}\n`,
  );
}

const BACKUP_WATCH_INTERVAL_MS = 1000;

/**
 * `backup status --watch`: re-render the panel once a second so the countdown
 * to the next run moves, and stop once the node it is watching goes away.
 *
 * On a terminal the panel is redrawn in place: the cursor is moved back over
 * exactly the lines printed last time and cleared from there, so earlier
 * terminal output is untouched. Piped output gets control codes stripped of
 * meaning, so a new panel is written only when the record actually changes
 * instead of one identical copy per second — the ticking countdown is a
 * terminal affordance, not something to fill a log file with.
 */
async function watchBackupStatus(ctx) {
  const interactive = Boolean(process.stdout.isTTY);
  let drawn = 0;
  let lastKey = null;
  let sawRunning = false;

  const restoreCursor = () => {
    if (interactive) {
      process.stdout.write('\x1b[?25h');
    }
  };
  const onSignal = () => {
    restoreCursor();
    process.stdout.write('\n');
    process.exit(0);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (interactive) {
      process.stdout.write('\x1b[?25l');
    }
    for (;;) {
      let lines = null;
      let payload = null;
      try {
        payload = backupStatusPayload(ctx);
        lines = backupStatusLines(ctx);
      } catch {
        // A status file caught mid-rewrite is retried on the next tick rather
        // than ending the watch, since the node writes it every so often.
      }

      if (lines) {
        const key = JSON.stringify([
          payload.configured,
          payload.pid,
          payload.running,
          payload.nextRunAt,
          payload.waitingForSync,
          payload.lastBackup?.at ?? null,
          payload.lastError,
          payload.lastAttemptAt,
          payload.recoveryHistory.length,
        ]);

        const hint = payload.running
          ? 'watching · refresh 1s · Ctrl+C to stop'
          : sawRunning
            ? 'node stopped'
            : 'waiting for a node to start with --backup-dir';
        const frame = [...lines, `  ${DIM}${hint}${RESET}`];

        if (interactive || key !== lastKey) {
          if (interactive && drawn > 0) {
            process.stdout.write(`\x1b[${drawn}A\r\x1b[J`);
          }
          process.stdout.write(`${frame.join('\n')}\n`);
          drawn = frame.length;
        }
        lastKey = key;

        if (payload.running) {
          sawRunning = true;
        } else if (sawRunning) {
          console.log(`  ${DIM}node stopped; watch ended${RESET}`);
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, BACKUP_WATCH_INTERVAL_MS));
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    restoreCursor();
  }
}

function requireWallet(ctx) {
  const wallet = openWallet(ctx);
  if (!wallet) {
    throw new Error(`no wallet in ${ctx.dir}. Run "doubloom init" first.`);
  }
  return wallet;
}

function walletStorage(wallet) {
  if (!wallet) {
    return 'none';
  }
  return wallet.isEncrypted ? 'encrypted' : 'plaintext';
}

/**
 * Prompt for a new passphrase, confirming it when a human is typing. The
 * environment override is configurable because changing a passphrase needs
 * two different values: the current one and the replacement.
 */
async function readNewPassphrase(envName = 'DOUBLOOM_PASSPHRASE') {
  const fromEnvironment = process.env[envName];
  const passphrase =
    fromEnvironment !== undefined
      ? fromEnvironment
      : await readPassphrase('New wallet passphrase: ', null);
  assertPassphrase(passphrase);
  if (fromEnvironment !== undefined) {
    return passphrase;
  }
  const confirmation = await readPassphrase('Confirm new passphrase: ', null);
  if (confirmation !== passphrase) {
    throw new Error('passphrases do not match');
  }
  return passphrase;
}

/**
 * Decrypt an encrypted wallet into memory so it can sign. Nothing is written:
 * the file on disk stays encrypted, and the keys vanish when the process exits.
 */
async function unlockForSigning(wallet, ctx) {
  if (!wallet.isEncrypted) {
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const passphrase = await readPassphrase(
      `Enter the passphrase for the ${ctx.params.name} wallet: `,
    );
    try {
      wallet.unlock(passphrase);
      return;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      console.error(`${RED}${error.message}${RESET}; try again`);
    }
  }
}

function supplyCapPercent(circulating, params) {
  const percent = Number((circulating * 10_000n) / params.maxMoney) / 100;
  return `${percent.toFixed(4)}% of ${formatAmount(MAX_MONEY)} DBL`;
}

function findTransaction(chain, id) {
  const height = chain.txIndex.get(id);
  if (height !== undefined) {
    const block = chain.blocks[height];
    return {
      transaction: block.transactions.find((tx) => txid(tx) === id),
      height,
      confirmations: chain.height - height + 1,
      blockHash: headerHash(block.header),
    };
  }
  const pending = chain.mempool.get(id);
  if (pending) {
    return { transaction: pending, height: null, confirmations: 0, blockHash: null };
  }
  return null;
}

function previousOutput(chain, id, vout) {
  const height = chain.txIndex.get(id);
  if (height === undefined) {
    return null;
  }
  const transaction = chain.blocks[height].transactions.find(
    (tx) => txid(tx) === id,
  );
  const output = transaction?.outputs[vout];
  return output ? { value: BigInt(output.value), address: output.address } : null;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'help';
  const args = positional.slice(1);

  if (command === 'help' || flags.help) {
    usage();
    return;
  }

  const ctx = context(flags);

  switch (command) {
    case 'init': {
      fs.mkdirSync(ctx.dir, { recursive: true });
      let chain = loadChain(ctx.params, ctx.chainFile);
      if (chain) {
        console.log(`${DIM}Chain already present, keeping it.${RESET}`);
      } else {
        chain = Chain.create(ctx.params);
        saveChain(chain, ctx.chainFile);
      }

      let wallet = openWallet(ctx);
      if (wallet) {
        console.log(`${DIM}Wallet already present, keeping it.${RESET}`);
      } else {
        wallet = Wallet.create(ctx.walletFile, ctx.params);
      }

      console.log(`\n${GOLD}${BOLD}Doubloom ${ctx.params.name} initialized${RESET}\n`);
      row('genesis', headerHash(chain.blocks[0].header));
      row('data', ctx.dir);
      row('block reward', `${formatAmount(subsidyAt(ctx.params, 1))} DBL`);
      row('halving', `${ctx.params.halvingInterval.toLocaleString()} blocks`);
      row('hard cap', `${formatAmount(ctx.params.maxMoney)} DBL`);
      row('address', `${GOLD}${wallet.defaultKey().address}${RESET}`);
      console.log(
        `\n${DIM}Mine your first coins with: doubloom mine --blocks 1${RESET}\n`,
      );
      return;
    }

    case 'info': {
      const chain = openChain(ctx);
      const wallet = openWallet(ctx);
      const reward = subsidyAt(ctx.params, chain.height + 1);
      const backupStatus = loadBackupStatus({
        statusFile: backupStatusFile(ctx.chainFile),
        network: ctx.params.name,
      });
      const backupRunning = Boolean(
        backupStatus?.pid && processIsRunning(backupStatus.pid),
      );
      const nodeState = loadNodeState({
        stateFile: nodeStateFile(ctx.chainFile),
        network: ctx.params.name,
      });
      const nodeRunning = Boolean(
        nodeState?.pid && processIsRunning(nodeState.pid),
      );
      // Only a live node has a miner to report, and a node that does not answer
      // is left as unknown rather than guessed at from the local command line.
      const nodeMining = nodeRunning ? await nodeMiningState(nodeState.port) : null;

      if (flags.json) {
        const key = wallet?.defaultKey();
        console.log(
          JSON.stringify(
            {
              network: ctx.params.name,
              ticker: ctx.params.ticker,
              symbol: ctx.params.symbol,
              height: chain.height,
              bestBlockHash: headerHash(chain.tip.header),
              time: chain.tip.header.time,
              difficulty: chain.difficulty(),
              // Decimal string: cumulative work outgrows a JS number once
              // difficulty rises, so it is reported in full as BigInt text.
              work: chain.work.toString(),
              supply: formatAmount(chain.circulatingSupply),
              maxSupply: formatAmount(MAX_MONEY),
              nextSubsidy: formatAmount(reward),
              mempool: chain.mempool.size,
              utxos: chain.utxos.size,
              explorer: nodeState?.url ?? null,
              announce: nodeState?.announce ?? null,
              node: nodeState
                ? {
                    running: nodeRunning,
                    pid: nodeState.pid,
                    port: nodeState.port,
                    startedAt: nodeState.startedAt,
                    // Whether that node's miner is on: true, false, or null when
                    // no node is running or it did not answer.
                    mining: nodeMining,
                  }
                : null,
              backup: backupStatus
                ? {
                    running: backupRunning,
                    directory: backupStatus.directory,
                    intervalMs: backupStatus.intervalMs,
                    retention: backupStatus.retention,
                    recoveryHistoryLimit:
                      backupStatus.recoveryHistoryLimit ?? 5,
                    firstDelayMs: backupStatus.firstDelayMs,
                    firstMaxWaitMs: backupStatus.firstMaxWaitMs,
                    nextRunAt: backupRunning
                      ? backupStatus.nextRunAt
                      : null,
                    lastBackup: backupStatus.lastBackup,
                    lastRecovery: backupStatus.lastRecovery,
                    recoveryHistory: backupStatus.recoveryHistory,
                  }
                : null,
              wallet: {
                storage: walletStorage(wallet),
                address: key?.address ?? null,
                balance: key
                  ? formatAmount(chain.balanceOf(key.address))
                  : null,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`\n${GOLD}${BOLD}Doubloom ${ctx.params.name}${RESET} ${DIM}(${ctx.params.ticker})${RESET}\n`);
      row('height', chain.height.toLocaleString());
      row('best block', headerHash(chain.tip.header));
      row('time', timestamp(chain.tip.header.time));
      row('difficulty', chain.difficulty().toLocaleString());
      // Grouped like the explorer's Chain work card, and shortened past 15
      // digits the same way, so the two figures can be compared by eye.
      row('chain work', formatWork(chain.work));
      row('next reward', `${formatAmount(reward)} DBL`);
      row('supply', `${formatAmount(chain.circulatingSupply)} DBL`);
      row('minted', supplyCapPercent(chain.circulatingSupply, ctx.params));
      row('hard cap', `${formatAmount(MAX_MONEY)} DBL`);
      row('mempool', `${chain.mempool.size} transaction(s)`);
      row('utxo set', `${chain.utxos.size} output(s)`);
      if (nodeState) {
        row(
          'announced',
          `${nodeState.announce}${
            nodeRunning
              ? ` ${DIM}pid ${nodeState.pid}${RESET}`
              : ` ${DIM}last run${RESET}`
          }`,
        );
        row(
          'miner',
          nodeRunning
            ? nodeMining === null
              ? `${DIM}unknown (the node did not answer)${RESET}`
              : nodeMining
                ? `${GOLD}mining${RESET}`
                : 'paused'
            : `${DIM}node not running${RESET}`,
        );
      }
      if (backupStatus?.lastBackup) {
        const last = backupStatus.lastBackup;
        row(
          'last backup',
          `${isoTimestamp(last.at)}  height ${last.height.toLocaleString()}  ${last.path}`,
        );
      }
      if (
        backupStatus?.nextRunAt &&
        processIsRunning(backupStatus.pid)
      ) {
        row(
          'next backup',
          `${isoTimestamp(backupStatus.nextRunAt)} ${DIM}(${
            backupStatus.waitingForSync
              ? 'waiting for sync'
              : timeFromNow(backupStatus.nextRunAt)
          })${RESET}${
            Number.isFinite(backupStatus.firstDelayMs)
              ? ` ${DIM}· first delay ${formatDuration(backupStatus.firstDelayMs)}${RESET}`
              : ''
          }${
            Number.isFinite(backupStatus.firstMaxWaitMs) &&
            backupStatus.firstMaxWaitMs > 0
              ? ` ${DIM}· sync wait cap ${formatDuration(backupStatus.firstMaxWaitMs)}${RESET}`
              : ''
          }`,
        );
      }
      if (Number.isFinite(backupStatus?.intervalMs)) {
        row(
          'backup config',
          `every ${formatDuration(backupStatus.intervalMs)} · ${retentionSummary(
            backupStatus.retention,
          )} · recoveries ${backupStatus.recoveryHistoryLimit ?? 5}`,
        );
      }
      const recoveryHistory = backupStatus?.recoveryHistory?.length
        ? backupStatus.recoveryHistory
        : backupStatus?.lastRecovery
          ? [backupStatus.lastRecovery]
          : [];
      if (recoveryHistory.length > 0) {
        row(
          'last recovery',
          `${isoTimestamp(recoveryHistory[0].at)} · ${recoveryHistory[0].reason}`,
        );
        for (const recovery of recoveryHistory.slice(1)) {
          row(
            'earlier',
            `${isoTimestamp(recovery.at)} · ${recovery.reason}`,
          );
        }
      }
      row('key storage', walletStorage(wallet));
      if (wallet?.defaultKey()) {
        row(
          'wallet',
          `${formatAmount(chain.balanceOf(wallet.defaultKey().address))} DBL ${DIM}${wallet.defaultKey().address}${RESET}`,
        );
      }
      console.log();
      return;
    }

    case 'address': {
      const wallet = requireWallet(ctx);
      for (const key of wallet.listKeys()) {
        console.log(
          `${key.address}${key.label ? ` ${DIM}(${key.label})${RESET}` : ''}`,
        );
      }
      return;
    }

    case 'balance': {
      const chain = openChain(ctx);
      const wallet = openWallet(ctx);
      const address = args[0] ?? wallet?.defaultKey()?.address;
      if (!address) {
        throw new Error('no wallet address available; pass one explicitly');
      }
      decodeAddress(address, ctx.params.addressVersion);

      const utxos = chain.utxosFor(address);
      const nextHeight = chain.height + 1;
      let confirmed = 0n;
      let spendable = 0n;
      let immature = 0n;
      for (const utxo of utxos) {
        confirmed += utxo.value;
        if (!utxo.coinbase || nextHeight - utxo.height >= ctx.params.coinbaseMaturity) {
          spendable += utxo.value;
        } else {
          immature += utxo.value;
        }
      }

      let pending = 0n;
      for (const transaction of chain.mempool.values()) {
        for (const output of transaction.outputs) {
          if (output.address === address) {
            pending += BigInt(output.value);
          }
        }
      }

      console.log(`\n${GOLD}${address}${RESET}\n`);
      row('confirmed', `${formatAmount(confirmed)} DBL`);
      row('spendable', `${formatAmount(spendable)} DBL`);
      row('immature', `${formatAmount(immature)} DBL ${DIM}(coinbase maturity)${RESET}`);
      row('pending', `${formatAmount(pending)} DBL ${DIM}(unconfirmed)${RESET}`);
      row('outputs', String(utxos.length));
      console.log();
      return;
    }

    case 'send': {
      const chain = openChain(ctx);
      const wallet = requireWallet(ctx);
      const [to, amount] = args;
      if (!to || !amount) {
        throw new Error('usage: doubloom send <address> <amount>');
      }

      await unlockForSigning(wallet, ctx);

      const result = wallet.buildTransaction(chain, {
        from: flags.from,
        to,
        amount,
        feeRate: flags['fee-rate'] ? Number(flags['fee-rate']) : undefined,
      });
      chain.addTransaction(result.transaction);
      saveChain(chain, ctx.chainFile);

      console.log(`\n${GOLD}Transaction signed${RESET}\n`);
      row('txid', result.txid);
      row('to', to);
      row('amount', `${formatAmount(result.transaction.outputs[0].value)} DBL`);
      row('fee', `${formatAmount(result.fee)} DBL`);
      row('change', `${formatAmount(result.change)} DBL`);
      row('mempool', `${chain.mempool.size} transaction(s)`);
      console.log(
        `\n${DIM}Broadcast it from a running node, or include it with: doubloom mine${RESET}\n`,
      );
      return;
    }

    case 'mempool': {
      const chain = openChain(ctx);
      const entries = chain.mempoolEntries();
      if (entries.length === 0) {
        console.log('Mempool is empty.');
        return;
      }
      console.log(
        `\n${BOLD}${entries.length} pending transaction(s)${RESET}\n`,
      );
      for (const entry of entries) {
        console.log(`${GOLD}${entry.id}${RESET}`);
        row('fee', `${formatAmount(entry.fee)} DBL`);
        row('size', `${entry.size} bytes (${entry.feeRate.toFixed(2)} petal/byte)`);
        row('outputs', entry.transaction.outputs.map((output) => `${formatAmount(output.value)} DBL`).join(', '));
        console.log();
      }
      return;
    }

    case 'mine': {
      const chain = openChain(ctx);
      const wallet = openWallet(ctx);
      const address = flags.address ?? wallet?.defaultKey()?.address;
      if (!address) {
        throw new Error('no mining address; run "doubloom init" or pass --address');
      }
      decodeAddress(address, ctx.params.addressVersion);

      const count = Math.max(1, Number(flags.blocks ?? 1) || 1);
      console.log(
        `\n${GOLD}Mining ${count} block(s) to ${address}${RESET}\n`,
      );

      for (let mined = 0; mined < count; mined += 1) {
        const block = chain.buildBlock(address);
        const started = Date.now();
        mineHeader(block.header);
        const result = chain.addBlock(block);
        saveChain(chain, ctx.chainFile);

        const reward = block.transactions[0].outputs[0].value;
        console.log(
          `${GOLD}#${result.height}${RESET} ${result.hash}`,
        );
        row(
          'reward',
          `${formatAmount(BigInt(reward))} DBL ${DIM}+ ${block.transactions.length - 1} tx${RESET}`,
        );
        row('nonce', String(block.header.nonce));
        row('time', timestamp(block.header.time));
        row('took', `${((Date.now() - started) / 1000).toFixed(2)}s`);
        console.log();
      }
      return;
    }

    case 'mining': {
      const subcommand = args[0] ?? 'status';
      // Loopback by default, like the explorer's own calls, or an explicit
      // origin for a node this machine did not start.
      const nodeUrl = miningNodeUrl(ctx, flags);
      const call = async (path, options) => {
        let response;
        try {
          response = await fetch(`${nodeUrl}${path}`, {
            ...options,
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          throw new Error(
            `no node answering at ${nodeUrl}; start one with "doubloom node" or pass --port/--url`,
          );
        }
        const payload = await response.json().catch(() => ({}));
        if (response.status === 404) {
          throw new Error(
            `the node at ${nodeUrl} does not expose /api/mining; update it`,
          );
        }
        if (!response.ok) {
          throw new Error(
            payload.error ?? `node returned HTTP ${response.status}`,
          );
        }
        return payload;
      };

      if (subcommand === 'status') {
        const state = await call('/api/mining');
        if (flags.json) {
          // Same fields the panel shows, with stable types: a script should not
          // have to parse "mining"/"paused" out of coloured text.
          console.log(
            JSON.stringify(
              {
                node: nodeUrl,
                mining: state.mining === true,
                address: state.address ?? null,
                height: state.height ?? null,
                difficulty: state.difficulty ?? null,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`\n${BOLD}Mining${RESET} ${DIM}${nodeUrl}${RESET}\n`);
        row('state', state.mining ? `${GOLD}mining${RESET}` : 'paused');
        row('address', state.address ?? `${DIM}none${RESET}`);
        row('height', Number(state.height ?? 0).toLocaleString());
        row('difficulty', Number(state.difficulty ?? 0).toLocaleString());
        console.log();
        return;
      }

      const enabled =
        subcommand === 'pause' ? false : subcommand === 'resume' ? true : null;
      if (enabled === null) {
        throw new Error(
          'usage: doubloom mining [status|pause|resume] [--port N | --url URL]',
        );
      }

      const result = await call('/api/mining', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      console.log(
        `\n${GOLD}${result.mining ? 'Mining resumed' : 'Mining paused'}${RESET}\n`,
      );
      if (!result.changed) {
        row('note', `already ${result.mining ? 'mining' : 'paused'}`);
      }
      row('node', nodeUrl);
      row('address', result.address ?? `${DIM}none${RESET}`);
      row('height', Number(result.height ?? 0).toLocaleString());
      row('state', result.mining ? 'mining' : 'paused');
      console.log();
      return;
    }

    case 'blocks': {
      const chain = openChain(ctx);
      const limit = Math.min(Number(flags.limit ?? 10) || 10, 100);
      const start = Math.max(0, chain.blocks.length - limit);
      console.log(`\n${BOLD}Latest blocks${RESET}\n`);
      for (let height = chain.blocks.length - 1; height >= start; height -= 1) {
        const block = chain.blocks[height];
        console.log(
          `${GOLD}#${String(height).padStart(6, ' ')}${RESET}  ${headerHash(block.header)}  ${DIM}${timestamp(block.header.time)} · ${block.transactions.length} tx${RESET}`,
        );
      }
      console.log();
      return;
    }

    case 'block': {
      const chain = openChain(ctx);
      const identifier = args[0];
      if (identifier === undefined) {
        throw new Error('usage: doubloom block <height|hash>');
      }
      const height = /^\d+$/.test(identifier)
        ? Number(identifier)
        : chain.blocks.findIndex(
            (block) => headerHash(block.header) === identifier,
          );
      const block = chain.blocks[height];
      if (!block) {
        throw new Error('block not found');
      }

      console.log(`\n${GOLD}${BOLD}Block #${height}${RESET}\n`);
      row('hash', headerHash(block.header));
      row('previous', block.header.prevHash);
      row('merkle root', block.header.merkleRoot);
      row('time', timestamp(block.header.time));
      row('bits', `0x${block.header.bits.toString(16).padStart(8, '0')}`);
      row('nonce', String(block.header.nonce));
      row('size', `${Buffer.byteLength(JSON.stringify(block))} bytes`);
      row('transactions', String(block.transactions.length));
      console.log(`\n${BOLD}Transactions${RESET}`);
      block.transactions.forEach((transaction, index) => {
        const id = txid(transaction);
        const label = index === 0 ? `${DIM}coinbase${RESET} ` : '';
        console.log(`  ${GOLD}${id}${RESET} ${label}${DIM}${transaction.inputs.length} in / ${transaction.outputs.length} out${RESET}`);
      });
      console.log();
      return;
    }

    case 'tx': {
      const chain = openChain(ctx);
      const id = args[0];
      if (!id) {
        throw new Error('usage: doubloom tx <txid>');
      }
      const found = findTransaction(chain, id);
      if (!found) {
        throw new Error('transaction not found');
      }
      const { transaction } = found;

      let inputTotal = 0n;
      const inputs = transaction.inputs.map((input) => {
        const previous = input.coinbase !== undefined
          ? null
          : previousOutput(chain, input.prevTxid, input.vout);
        if (previous) {
          inputTotal += previous.value;
        }
        return { ...input, previous };
      });
      const outputTotal = transaction.outputs.reduce(
        (total, output) => total + BigInt(output.value),
        0n,
      );

      console.log(`\n${GOLD}${BOLD}Transaction${RESET}\n`);
      row('txid', id);
      row('status', found.height === null ? 'unconfirmed (mempool)' : `confirmed in block #${found.height} (${found.confirmations} confirmation(s))`);
      if (found.blockHash) {
        row('block', found.blockHash);
      }
      row('size', `${Buffer.byteLength(JSON.stringify(transaction))} bytes`);
      row('inputs', String(transaction.inputs.length));
      row('outputs', String(transaction.outputs.length));

      if (transaction.inputs[0]?.coinbase !== undefined) {
        row('coinbase', `block ${transaction.inputs[0].height}`);
      } else {
        for (const input of inputs) {
          const source = input.previous
            ? `${formatAmount(input.previous.value)} DBL ${DIM}${input.previous.address}${RESET}`
            : `${DIM}unknown${RESET}`;
          console.log(`  ${DIM}in ${RESET} ${input.prevTxid}:${input.vout}  ${source}`);
        }
        for (const output of transaction.outputs) {
          console.log(`  ${DIM}out${RESET} ${formatAmount(output.value)} DBL  ${output.address}`);
        }
        if (inputTotal > 0n) {
          row('fee', `${formatAmount(inputTotal - outputTotal)} DBL`);
        }
      }
      console.log();
      return;
    }

    case 'validate': {
      const chain = openChain(ctx);
      chain.validate();
      console.log(`\n${GOLD}Chain valid${RESET}\n`);
      row('blocks', String(chain.blocks.length));
      row('tip', headerHash(chain.tip.header));
      row('utxos', String(chain.utxos.size));
      row('mempool', String(chain.mempool.size));
      console.log();
      return;
    }

    case 'backup': {
      if (args[0] === 'list') {
        printBackupArchives(ctx, flags);
        return;
      }
      if (args[0] === 'status') {
        if (flags.watch) {
          if (flags.json) {
            throw new Error(
              '--watch redraws the panel; drop --json, or poll "doubloom backup status --json" for one record at a time',
            );
          }
          await watchBackupStatus(ctx);
          return;
        }
        if (flags.json) {
          console.log(JSON.stringify(backupStatusPayload(ctx), null, 2));
          return;
        }
        printBackupStatus(ctx);
        return;
      }
      if (args[0] === 'now') {
        await triggerNodeBackup(ctx, flags);
        return;
      }
      const destination = args[0];
      if (!destination) {
        throw new Error(
          'usage: doubloom backup <file> | doubloom backup now [--to <path>] | doubloom backup status',
        );
      }
      const wallet = requireWallet(ctx);
      if (!wallet.isEncrypted) {
        throw new Error(
          'wallet is not encrypted; run "doubloom wallet lock" before backing up the node',
        );
      }
      if (!fs.existsSync(ctx.chainFile)) {
        throw new Error(`no chain in ${ctx.dir}. Run "doubloom init" first.`);
      }

      const passphrase = await readPassphrase(
        `Enter the passphrase for the ${ctx.params.name} wallet: `,
      );
      const result = createNodeBackup({
        params: ctx.params,
        chainFile: ctx.chainFile,
        walletFile: ctx.walletFile,
        destination: path.resolve(destination),
        passphrase,
      });

      console.log(`\n${GOLD}Node backup written and verified${RESET}\n`);
      row('file', result.path);
      row(
        'size',
        `${result.bytes.toLocaleString()} bytes gzipped ${DIM}(from ${result.rawBytes.toLocaleString()})${RESET}`,
      );
      row('network', ctx.params.name);
      row('height', result.height.toLocaleString());
      row('tip', result.tip);
      row('keys', String(result.keys));
      console.log(
        `\n${DIM}The archive holds every confirmed block and the encrypted wallet;
unconfirmed mempool transactions are not included. Restore it with
"doubloom restore <file>" after stopping any node on this data directory.${RESET}\n`,
      );
      return;
    }

    case 'restore': {
      const source = args[0];
      if (!source) {
        throw new Error('usage: doubloom restore <file>');
      }
      const existing = [ctx.chainFile, ctx.walletFile].filter((file) =>
        fs.existsSync(file),
      );
      if (existing.length > 0 && !flags.force) {
        throw new Error(
          `node data already exists at ${existing.join(' and ')}; move it aside or pass --force to overwrite it`,
        );
      }

      const passphrase = await readPassphrase(
        'Enter the passphrase for the backup wallet: ',
      );
      const result = restoreNodeBackup({
        source: path.resolve(source),
        params: ctx.params,
        chainFile: ctx.chainFile,
        walletFile: ctx.walletFile,
        passphrase,
        force: Boolean(flags.force),
      });

      console.log(`\n${GOLD}Node restored and verified${RESET}\n`);
      row('data', ctx.dir);
      row('height', result.height.toLocaleString());
      row('tip', result.tip);
      row('keys', String(result.keys));
      for (const address of result.addresses) {
        console.log(`  ${GOLD}${address}${RESET}`);
      }
      console.log(
        `\n${DIM}The restored wallet keeps its original passphrase. Start the node
with "doubloom node" when you are ready.${RESET}\n`,
      );
      return;
    }

    case 'wallet': {
      const subcommand = args[0] ?? 'list';
      if (subcommand === 'new') {
        const wallet = requireWallet(ctx);
        await unlockForSigning(wallet, ctx);
        const key = wallet.newKey(String(flags.label ?? ''));
        wallet.save();
        console.log(`\n${GOLD}New address${RESET}\n`);
        row('address', key.address);
        row('label', String(flags.label ?? ''));
        console.log();
        return;
      }
      if (subcommand === 'list') {
        const wallet = requireWallet(ctx);
        console.log(`\n${BOLD}Wallet keys${RESET}\n`);
        for (const key of wallet.listKeys()) {
          console.log(
            `  ${GOLD}${key.address}${RESET}  ${key.label || DIM + 'unlabeled' + RESET}`,
          );
        }
        console.log();
        return;
      }
      if (subcommand === 'lock') {
        const wallet = requireWallet(ctx);
        if (wallet.isEncrypted) {
          console.log(`\n${DIM}Wallet is already encrypted.${RESET}\n`);
          return;
        }
        const passphrase = await readNewPassphrase();
        wallet.encrypt(passphrase);
        console.log(`\n${GOLD}Wallet locked${RESET}\n`);
        row('file', ctx.walletFile);
        row('cipher', 'aes-256-gcm');
        row('kdf', 'scrypt (N=32768, r=8, p=1)');
        row('keys', String(wallet.listKeys().length));
        console.log(
          `\n${RED}${BOLD}There is no passphrase recovery.${RESET}${RED} Without it the
keys cannot be decrypted and the coins are lost forever. Back up the
wallet file and the passphrase separately, offline.${RESET}\n`,
        );
        return;
      }
      if (subcommand === 'passphrase') {
        const wallet = requireWallet(ctx);
        if (!wallet.isEncrypted) {
          throw new Error(
            'wallet has no passphrase; run "doubloom wallet lock" to set one',
          );
        }
        await unlockForSigning(wallet, ctx);
        const passphrase = await readNewPassphrase('DOUBLOOM_NEW_PASSPHRASE');
        wallet.changePassphrase(passphrase);
        console.log(`\n${GOLD}Passphrase changed${RESET}\n`);
        row('file', ctx.walletFile);
        row('cipher', 'aes-256-gcm');
        row('kdf', 'scrypt (N=32768, r=8, p=1)');
        row('keys', String(wallet.listKeys().length));
        console.log(
          `\n${RED}${BOLD}There is no passphrase recovery.${RESET}${RED} The old
passphrase no longer works. Back up the new one offline.${RESET}\n`,
        );
        return;
      }
      if (subcommand === 'backup') {
        const destination = args[1];
        if (!destination) {
          throw new Error('usage: doubloom wallet backup <file>');
        }
        const wallet = requireWallet(ctx);
        if (!wallet.isEncrypted) {
          throw new Error(
            'wallet is not encrypted; run "doubloom wallet lock" before backing it up',
          );
        }
        const passphrase = await readPassphrase(
          `Enter the passphrase for the ${ctx.params.name} wallet: `,
        );
        const result = wallet.backup(path.resolve(destination), passphrase);
        console.log(`\n${GOLD}Backup written and verified${RESET}\n`);
        row('file', result.path);
        // The same stamp `wallet restore` prints, so an operator can match the
        // export they made against the one they later restored.
        row(
          'backup time',
          `${isoTimestamp(result.at)} ${DIM}(${timeAgo(result.at)})${RESET}`,
        );
        row(
          'size',
          `${result.bytes.toLocaleString()} bytes gzipped ${DIM}(from ${result.rawBytes.toLocaleString()})${RESET}`,
        );
        row('keys', String(result.keys));
        row('cipher', 'aes-256-gcm');
        console.log(
          `\n${DIM}The copy was decrypted with this passphrase to prove it is
usable. It stays encrypted at rest; store it separately from the
passphrase. Restore it with: doubloom wallet restore <file>${RESET}\n`,
        );
        return;
      }
      if (subcommand === 'restore') {
        const source = args[1];
        if (!source) {
          throw new Error('usage: doubloom wallet restore <file>');
        }
        if (fs.existsSync(ctx.walletFile) && !flags.force) {
          throw new Error(
            `a wallet already exists at ${ctx.walletFile}; move it aside or pass --force to overwrite it`,
          );
        }
        const passphrase = await readPassphrase(
          'Enter the passphrase for the backup: ',
        );
        const sourcePath = path.resolve(source);
        const wallet = Wallet.restore(
          sourcePath,
          ctx.walletFile,
          ctx.params,
          passphrase,
          { force: Boolean(flags.force) },
        );
        // Read from the archive itself, not the clock: this is when the export
        // being installed was made, not when it is being installed. Read after
        // the restore so a missing file reports the restore's own error.
        const backedUpAt = backupArchiveTime(sourcePath);
        console.log(`\n${GOLD}Wallet restored and verified${RESET}\n`);
        row(
          'backup time',
          `${isoTimestamp(backedUpAt)} ${DIM}(${timeAgo(backedUpAt)})${RESET}`,
        );
        row('file', ctx.walletFile);
        const keyCount = wallet.listKeys().length;
        row('keys', `${keyCount} ${DIM}from this backup${RESET}`);
        row('cipher', 'aes-256-gcm');
        for (const key of wallet.listKeys()) {
          console.log(
            `  ${GOLD}${key.address}${RESET}  ${key.label || DIM + 'unlabeled' + RESET}`,
          );
        }
        console.log(
          `\n${DIM}The wallet keeps the passphrase it had when the backup was made.${RESET}\n`,
        );
        return;
      }
      if (subcommand === 'unlock') {
        const wallet = requireWallet(ctx);
        if (!wallet.isEncrypted) {
          console.log(`\n${DIM}Wallet is already unencrypted; no passphrase needed.${RESET}\n`);
          return;
        }
        const passphrase = await readPassphrase(
          `Enter the passphrase for the ${ctx.params.name} wallet: `,
        );
        wallet.decryptToPlaintext(passphrase);
        console.log(`\n${GOLD}Wallet decrypted${RESET}\n`);
        row('file', ctx.walletFile);
        row('keys', String(wallet.listKeys().length));
        console.log(
          `\n${RED}Private keys are now stored unencrypted on disk.${RESET} Run
"doubloom wallet lock" as soon as you are done signing.${RESET}\n`,
        );
        return;
      }
      if (subcommand === 'balance') {
        throw new Error('use: doubloom balance');
      }
      throw new Error(`unknown wallet subcommand "${subcommand}"`);
    }

    case 'node': {
      const { startNode } = await import('./node.js');
      const chain = openChain(ctx);
      const wallet = openWallet(ctx);
      const address = flags.address ?? wallet?.defaultKey()?.address;
      const peers = String(flags.peers ?? '')
        .split(',')
        .map((peer) => peer.trim())
        .filter(Boolean);

      if (flags.announce === true) {
        throw new Error(
          '--announce requires a host, host:port or http://host:port',
        );
      }
      if (flags['announce-interface'] === true) {
        throw new Error(
          '--announce-interface requires a network interface name such as eth0 or en0',
        );
      }

      let seeds = [...(ctx.params.dnsSeeds ?? [])];
      if (flags.seed !== undefined) {
        if (flags.seed === true) {
          throw new Error(
            '--seed requires a comma-separated list of hostnames (use "none" to disable)',
          );
        }
        const raw = String(flags.seed).trim();
        seeds =
          raw.length === 0 || /^(none|off|false)$/i.test(raw)
            ? []
            : raw
                .split(',')
                .map((seed) => seed.trim())
                .filter(Boolean);
      }
      if (flags['no-seed']) {
        seeds = [];
      }

      let backup = null;
      if (flags['backup-dir'] !== undefined) {
        if (flags['backup-dir'] === true) {
          throw new Error('--backup-dir requires a path');
        }
        if (!wallet) {
          throw new Error('automatic backups need a wallet; run "doubloom init" first');
        }
        if (!wallet.isEncrypted) {
          throw new Error(
            'wallet is not encrypted; run "doubloom wallet lock" before enabling automatic backups',
          );
        }

        const minutes = Number(flags['backup-interval'] ?? 60);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          throw new Error('--backup-interval must be a positive number of minutes');
        }
        const retentionFlag = (name) => {
          const raw = flags[name];
          if (raw === undefined) {
            return undefined;
          }
          if (raw === true) {
            throw new Error(`--${name} requires a count`);
          }
          const count = Number(raw);
          if (!Number.isInteger(count) || count < 0) {
            throw new Error(`--${name} must be a non-negative integer`);
          }
          return count;
        };
        const retention = {
          hourly: retentionFlag('backup-keep-hourly'),
          daily: retentionFlag('backup-keep-daily'),
          weekly: retentionFlag('backup-keep-weekly'),
        };
        const configuredTiers = Object.values(retention).filter(
          (count) => count !== undefined,
        );
        if (
          configuredTiers.length > 0 &&
          configuredTiers.every((count) => count === 0)
        ) {
          throw new Error('backup retention must keep at least one archive');
        }
        if (flags['backup-keep'] !== undefined) {
          throw new Error(
            '--backup-keep was replaced by --backup-keep-hourly, --backup-keep-daily and --backup-keep-weekly',
          );
        }
        let maxAgeMs;
        if (flags['backup-max-age'] !== undefined) {
          if (flags['backup-max-age'] === true) {
            throw new Error('--backup-max-age requires a number of minutes');
          }
          const maxAgeMinutes = Number(flags['backup-max-age']);
          if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
            throw new Error('--backup-max-age must be a positive number of minutes');
          }
          maxAgeMs = Math.round(maxAgeMinutes * 60_000);
        }
        let maxLagBlocks;
        if (flags['backup-max-lag'] !== undefined) {
          if (flags['backup-max-lag'] === true) {
            throw new Error('--backup-max-lag requires a number of blocks');
          }
          const lag = Number(flags['backup-max-lag']);
          if (!Number.isInteger(lag) || lag < 1) {
            throw new Error(
              '--backup-max-lag must be a positive whole number of blocks',
            );
          }
          maxLagBlocks = lag;
        }
        const recoveryHistoryLimit = Number(
          flags['backup-recovery-history'] ?? 5,
        );
        if (!Number.isInteger(recoveryHistoryLimit) || recoveryHistoryLimit < 1) {
          throw new Error('--backup-recovery-history must be a positive integer');
        }

        // 0 turns the periodic restore check off; leaving the flag out keeps
        // the scheduler's default.
        let verifyIntervalMs;
        if (flags['backup-verify-interval'] !== undefined) {
          if (flags['backup-verify-interval'] === true) {
            throw new Error(
              '--backup-verify-interval requires a number of minutes (0 disables)',
            );
          }
          const verifyMinutes = Number(flags['backup-verify-interval']);
          if (!Number.isFinite(verifyMinutes) || verifyMinutes < 0) {
            throw new Error(
              '--backup-verify-interval must be zero or more minutes',
            );
          }
          verifyIntervalMs = Math.round(verifyMinutes * 60_000);
        }

        let firstDelayMs;
        if (flags['backup-first-delay'] !== undefined) {
          if (flags['backup-first-delay'] === true) {
            throw new Error('--backup-first-delay requires a number of seconds');
          }
          const seconds = Number(flags['backup-first-delay']);
          if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error('--backup-first-delay must be zero or more seconds');
          }
          firstDelayMs = Math.round(seconds * 1000);
        }

        // 0 is the explicit opt-out: keep waiting for sync for as long as it
        // takes, rather than snapshotting a chain that is still filling in.
        let firstMaxWaitMs;
        if (flags['backup-first-max-wait'] !== undefined) {
          if (flags['backup-first-max-wait'] === true) {
            throw new Error(
              '--backup-first-max-wait requires a number of seconds (0 waits indefinitely)',
            );
          }
          const seconds = Number(flags['backup-first-max-wait']);
          if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error(
              '--backup-first-max-wait must be zero or more seconds',
            );
          }
          firstMaxWaitMs = Math.round(seconds * 1000);
        }

        const passphrase = await readPassphrase(
          'Enter the passphrase for automatic backups: ',
        );
        // Verify now, but keep the node's wallet locked. The schedule holds
        // the passphrase and opens the wallet only while writing a backup.
        Wallet.load(ctx.walletFile, ctx.params).unlock(passphrase);

        backup = {
          directory: path.resolve(String(flags['backup-dir'])),
          passphrase,
          firstDelayMs,
          firstMaxWaitMs,
          intervalMs: Math.max(1000, Math.round(minutes * 60_000)),
          maxAgeMs,
          maxLagBlocks,
          retention,
          recoveryHistoryLimit,
          verifyIntervalMs,
        };
      }

      const instance = startNode({
        chain,
        wallet,
        params: ctx.params,
        chainFile: ctx.chainFile,
        walletFile: ctx.walletFile,
        host: String(flags.host ?? '127.0.0.1'),
        port: Number(flags.port ?? ctx.params.defaultPort),
        announce:
          flags.announce === undefined ? undefined : String(flags.announce),
        announceInterface:
          flags['announce-interface'] === undefined
            ? undefined
            : String(flags['announce-interface']),
        peers,
        seeds,
        mine: Boolean(flags.mine),
        minerAddress: address,
        logLevel:
          flags['log-level'] === undefined
            ? undefined
            : String(flags['log-level']),
        backup,
      });

      const shutdown = async () => {
        console.log('\nshutting down');
        await instance.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    default:
      usage();
      throw new Error(`unknown command "${command}"`);
  }
}

main().catch((error) => {
  console.error(`${RED}error:${RESET} ${error.message}`);
  process.exitCode = 1;
});
