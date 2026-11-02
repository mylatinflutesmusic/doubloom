import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerHash, mineHeaderAsync } from './block.js';
import { saveChain } from './store.js';
import { formatAmount } from './amount.js';
import { txid } from './transaction.js';
import { decodeAddress } from './keys.js';
import { subsidyAt } from './chain.js';
import { listArchives, startBackupSchedule } from './backup-scheduler.js';
import { createBackupWorker } from './backup-thread.js';
import { discoverSeedPeers, parseSeed } from './peer-discovery.js';
import { nodeStateFile, saveNodeState } from './node-state.js';
import {
  appendReorg,
  loadReorgHistory,
  REORG_HISTORY_LIMIT,
  reorgHistoryFile,
} from './reorg-history.js';

/** How often configured DNS seeds are re-resolved to replace dead peers. */
const SEED_DISCOVERY_INTERVAL_MS = 300_000;
/**
 * Minimum spacing between fork-triggered chain fetches. Two nodes mining at
 * once reject each other's blocks continuously; without this, every rejection
 * would download the peer's whole chain.
 */
const SYNC_REQUEST_MIN_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PEERS = 8;
/** Backup job records kept for polling, so a reload can still find its job. */
const MAX_BACKUP_JOBS = 8;
/**
 * How long a node waits after binding before asking a peer whether the address
 * it announced actually answers. Five seconds leaves room for the first
 * announcement and peer sync to finish.
 */
const REACHABILITY_FIRST_DELAY_MS = 5_000;
/** How often that check is repeated while the node runs. */
const REACHABILITY_INTERVAL_MS = 600_000;
/** How long a peer waits for the announced address to answer the probe. */
const REACHABILITY_PROBE_TIMEOUT_MS = 4_000;
/**
 * How long after a new peer is discovered the reachability check runs. Long
 * enough to coalesce a seed pass that adds several peers, short enough that the
 * answer arrives while the operator is still looking at the startup log.
 */
const PEER_CHECK_DELAY_MS = 500;
/**
 * How often a wildcard-bound node re-reads its interfaces. A laptop that moves
 * between networks keeps its listener but not its address, and peers holding
 * the old one would dial a host that is no longer there.
 */
const ANNOUNCE_REFRESH_INTERVAL_MS = 30_000;

/** Header a relayed request carries, naming the peer that sent it. */
const PEER_HEADER = 'x-doubloom-from';
/**
 * How long a rejected push is still the fork being timed. Long enough to cover
 * the fetch's debounce and a periodic pass, short enough that a reorg minutes
 * later is reported as its own event rather than a slow answer to this push.
 */
const FORK_WATCH_MS = 60_000;
/** Log levels, widest first; see the `log` helper in `startNode`. */
const LOG_LEVELS = ['full', 'blocks', 'quiet'];

const EXPLORER_FILE = fileURLToPath(new URL('./explorer.html', import.meta.url));
const COIN_FILE = fileURLToPath(new URL('../assets/doubloom.svg', import.meta.url));

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** A peer URL as a bare origin, so `http://h:1/` and `http://h:1` match. */
function normalizePeerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** The host of a peer URL, or null when it does not parse. */
function hostOfPeer(peer) {
  try {
    return new URL(peer).hostname;
  } catch {
    return null;
  }
}

/** Socket addresses and URL hostnames spell the same host differently. */
function normalizeHost(address) {
  const text = String(address ?? '');
  const bare = text.replace(/^\[|\]$/g, '');
  return bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare;
}

/**
 * Endpoints that change what this process does or hand out its files. They
 * belong to the operator, not to a peer: the peer protocol needs only the
 * chain, block, transaction, mempool and peer endpoints, so a node reachable
 * from another machine still syncs while these stay shut to strangers.
 */
const CONTROL_ROUTES = [
  ['POST', '/api/mining'],
  ['POST', '/api/backup'],
  ['DELETE', '/api/backup/jobs/'],
  ['GET', '/api/backup/archives/'],
  ['GET', '/api/backup/download'],
];

/** Whether `method` and `pathname` match one of these routes; a trailing slash is a prefix. */
function matchesRoute(routes, method, pathname) {
  return routes.some(
    ([routeMethod, routePath]) =>
      routeMethod === method &&
      (routePath.endsWith('/')
        ? pathname.startsWith(routePath)
        : pathname === routePath),
  );
}

/** Whether this method and path belongs to the operator; a trailing slash is a prefix. */
export function isControlRoute(method, pathname) {
  return matchesRoute(CONTROL_ROUTES, method, pathname);
}

/**
 * The archive downloads, a subset of the operator routes. A backup holds the
 * whole chain and the encrypted wallet, so taking a copy is a bigger permission
 * than pausing the miner: the token unlocks the controls, and a copy from
 * another machine also needs the operator to say so.
 */
const DOWNLOAD_ROUTES = [
  ['GET', '/api/backup/archives/'],
  ['GET', '/api/backup/download'],
];

/** Whether this request would hand out a backup archive rather than steer the node. */
export function isDownloadRoute(method, pathname) {
  return matchesRoute(DOWNLOAD_ROUTES, method, pathname);
}

/** Whether a socket address is this machine, including the IPv4-mapped form. */
export function isLoopbackAddress(address) {
  const host = normalizeHost(address);
  return (
    host === '::1' || host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
function bearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }
  const token = /^Bearer[ \t]+(.+)$/i.exec(header.trim())?.[1].trim();
  return token ? token : null;
}

/**
 * Constant time, and the same comparison whatever was presented: both sides are
 * hashed first, so a wrong length cannot be told apart from a wrong token.
 */
function tokenMatches(presented, expected) {
  if (!presented || !expected) {
    return false;
  }
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

/**
 * Why a request may not use the operator endpoints, or null when it may.
 * Loopback is always the operator — the CLI and the explorer call from this
 * machine — and anything else needs the token the node was started with, so a
 * node without one keeps its controls here by default. Even with the token, an
 * archive stays put unless the operator opted into remote downloads.
 */
export function controlRefusalReason(
  { method, pathname, remoteAddress, authorization },
  apiToken = null,
  { allowRemoteDownloads = false } = {},
) {
  if (!isControlRoute(method, pathname)) {
    return null;
  }
  if (isLoopbackAddress(remoteAddress)) {
    return null;
  }
  if (!tokenMatches(bearerToken(authorization), apiToken)) {
    return (
      'this endpoint is available on loopback only, or with the token the node ' +
      'was started with (Authorization: Bearer ...)'
    );
  }
  if (isDownloadRoute(method, pathname) && !allowRemoteDownloads) {
    return (
      'backup archives carry the chain and the encrypted wallet, so they are ' +
      'downloaded on the node itself; start it with --allow-remote-downloads ' +
      'to permit a copy from another machine'
    );
  }
  return null;
}

/** Whether a request may use the operator endpoints. */
export function controlRouteAllowed(request, apiToken = null, options = {}) {
  return controlRefusalReason(request, apiToken, options) === null;
}

async function readJson(request, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new Error('request body is too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function formatPeers(count) {
  return `${count} peer${count === 1 ? '' : 's'}`;
}

/** Human-readable transfer size for the sync log. */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** SHA-256 of a file, streamed so a large archive is never held in memory. */
function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function formatBackupDelay(milliseconds) {
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const minutes = milliseconds / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

/**
 * The address peers should use to reach this node.
 *
 * A wildcard bind (`0.0.0.0`) listens everywhere but says nothing about which
 * of those addresses is reachable from another machine, so announcing the
 * loopback URL leaves every peer with a dead address. `--announce` names the
 * public one; `--announce-interface` names the local interface to take one
 * from; without either, the first routable interface address is used.
 */
function announceUrlFor(value, boundPort) {
  const entry = String(value ?? '').trim();
  const parsed = parseSeed(entry, boundPort);
  if (!parsed) {
    return null;
  }
  // A port written in the value wins, so a node behind port forwarding can
  // announce an address that is not the port it bound.
  const hasPort = /:\d+$/.test(
    entry.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
  );
  const port = hasPort ? parsed.port : boundPort;
  const host = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
  return `http://${host}:${port}`;
}

/**
 * The routable IPv4 address to announce: of one named interface, or of the
 * first interface that has one.
 *
 * Names differ per platform (`eth0`, `en0`, `Wi-Fi`), so a name this machine
 * does not have is a configuration mistake worth failing on: silently picking
 * another interface would announce an address the operator did not choose.
 * A known interface with no address right now (down, or waiting for DHCP)
 * returns null instead, because that state is temporary.
 */
function routableAddress(interfaceName) {
  const interfaces = os.networkInterfaces();

  function addressOf(entries) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }
      if (entry.family === 'IPv4' || entry.family === 4) {
        return entry.address;
      }
    }
    return null;
  }

  if (interfaceName === undefined) {
    for (const entries of Object.values(interfaces)) {
      const address = addressOf(entries);
      if (address) {
        return address;
      }
    }
    return null;
  }

  const name = String(interfaceName).trim();
  if (!Object.hasOwn(interfaces, name)) {
    const available = Object.keys(interfaces);
    throw new Error(
      `unknown network interface "${name}" (this machine has ${available.length > 0 ? available.join(', ') : 'none'})`,
    );
  }
  return addressOf(interfaces[name]);
}

/**
 * Ask a URL whether it is a Doubloom node.
 *
 * A node cannot tell whether the address it advertises is reachable from the
 * outside: its own request may take a shortcut through a local interface, and
 * NAT hairpinning often fails. A peer asking on its behalf is the honest test.
 */
async function probeNodeUrl(url) {
  try {
    const response = await fetch(`${url}/api/info`, {
      signal: AbortSignal.timeout(REACHABILITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { reachable: false, error: `HTTP ${response.status}` };
    }
    const info = await response.json();
    if (typeof info?.network !== 'string' || typeof info?.height !== 'number') {
      return { reachable: false, error: 'not a Doubloom node' };
    }
    return {
      reachable: true,
      network: info.network,
      height: info.height,
      mining: Boolean(info.mining),
    };
  } catch (error) {
    // undici hides the useful part (ECONNREFUSED, bad port, DNS failure) in
    // the cause, leaving only "fetch failed" on the error itself.
    const reason =
      error?.cause?.code ??
      error?.cause?.message ??
      error?.message ??
      'request failed';
    return { reachable: false, error: String(reason) };
  }
}

function summarizeBlock(block, height) {
  return {
    height,
    hash: headerHash(block.header),
    previous: block.header.prevHash,
    time: block.header.time,
    transactions: block.transactions.length,
    size: Buffer.byteLength(JSON.stringify(block)),
    difficultyBits: `0x${block.header.bits.toString(16).padStart(8, '0')}`,
  };
}

export function startNode(options) {
  const { chain, params, chainFile } = options;
  // Widest first: a level prints its own events and every one before it. The
  // default writes the log this node has always written; `blocks` drops the
  // per-transaction lines that a busy mempool would otherwise bury the chain
  // events under, and `quiet` leaves only warnings and errors.
  const logLevel = options.logLevel ?? 'full';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `unknown log level "${logLevel}" (expected ${LOG_LEVELS.join(' or ')})`,
    );
  }
  const logRank = LOG_LEVELS.indexOf(logLevel);
  /**
   * Write one line if it belongs to this node's log level. Warnings and errors
   * do not come through here: a quiet node is still expected to say when
   * something went wrong.
   */
  const log = (level, message) => {
    if (LOG_LEVELS.indexOf(level) >= logRank) {
      console.log(message);
    }
  };
  // A refused control request is worth saying out loud, but a stranger can send
  // them faster than anyone can read a log, so repeats are summarised: one line
  // per five seconds, carrying how many arrived since.
  let refusedControls = 0;
  let refusedControlLoggedAt = 0;
  function noteControlRefusal(method, pathname) {
    refusedControls += 1;
    const now = Date.now();
    if (refusedControlLoggedAt !== 0 && now - refusedControlLoggedAt < 5_000) {
      return;
    }
    refusedControlLoggedAt = now;
    console.warn(
      'refused ' +
        method +
        ' ' +
        pathname +
        ' from outside this machine (' +
        refusedControls +
        ' refused so far); control endpoints answer on loopback, or to a ' +
        'bearer token when one was configured',
    );
  }
  /**
   * The two endpoints a stranger can use to make this node do work it would
   * rather not: a transaction costs a validation and a chain write, and a peer
   * URL is dialled later. Rules are per address so one caller cannot crowd out
   * the rest, and loopback is the operator, so the CLI is never throttled.
   */
  const RATE_LIMIT_RULES = {
    tx: { limit: 60, windowMs: 60_000 },
    peers: { limit: 30, windowMs: 60_000 },
  };
  const rateWindows = new Map();
  let throttledRequests = 0;
  let throttledLoggedAt = 0;
  /** Answer a request over its address's allowance with 429, and say why. */
  function refuseThrottled(response, kind, address) {
    if (isLoopbackAddress(address)) {
      return false;
    }
    const rule = RATE_LIMIT_RULES[kind];
    const host = normalizeHost(address);
    const key = kind + '|' + host;
    const now = Date.now();
    // Windows are dropped when the map grows, so a stranger cannot make this
    // node remember addresses forever.
    if (rateWindows.size > 1024) {
      for (const [entry, window] of rateWindows) {
        if (now - window.start >= window.windowMs) {
          rateWindows.delete(entry);
        }
      }
      while (rateWindows.size > 1024) {
        let oldestKey = null;
        let oldestStart = Infinity;
        for (const [entry, window] of rateWindows) {
          if (window.start < oldestStart) {
            oldestStart = window.start;
            oldestKey = entry;
          }
        }
        rateWindows.delete(oldestKey);
      }
    }
    let window = rateWindows.get(key);
    if (!window || now - window.start >= window.windowMs) {
      window = { start: now, count: 0, windowMs: rule.windowMs };
      rateWindows.set(key, window);
    }
    window.count += 1;
    if (window.count <= rule.limit) {
      return false;
    }
    // One line per five seconds, like a refused control request: a caller that
    // keeps knocking is not worth a log line each time.
    throttledRequests += 1;
    if (throttledLoggedAt === 0 || now - throttledLoggedAt >= 5_000) {
      throttledLoggedAt = now;
      console.warn(
        'throttled ' +
          kind +
          ' requests from ' +
          host +
          ' (' +
          throttledRequests +
          ' refused so far); at most ' +
          rule.limit +
          ' per ' +
          Math.round(rule.windowMs / 1000) +
          's',
      );
    }
    const retryAfter = Math.max(
      1,
      Math.ceil((window.start + window.windowMs - now) / 1000),
    );
    response.setHeader('retry-after', String(retryAfter));
    sendJson(response, 429, {
      error:
        'too many ' + kind + ' requests from ' + host + '; retry in ' +
        retryAfter + 's',
    });
    return true;
  }
  const wallet = options.wallet ?? null;
  const host = options.host ?? '127.0.0.1';
  // Set only when the operator wants to reach the control endpoints from
  // another machine; without it they answer on loopback alone.
  const apiToken =
    typeof options.apiToken === 'string' && options.apiToken.trim() !== ''
      ? options.apiToken.trim()
      : null;
  // Taking a copy off this machine is a separate decision from steering it: a
  // token that leaks should not also hand over the wallet.
  const allowRemoteDownloads = options.allowRemoteDownloads === true;
  const port = options.port ?? params.defaultPort;
  const peers = new Set((options.peers ?? []).filter(Boolean));
  /**
   * Bytes this node has exchanged with each peer since it started, keyed by
   * peer URL. Kept apart from `peers` so the totals survive a peer dropping
   * out of the set: "sent 12 MB to this host" is still true once it is gone.
   */
  const peerTraffic = new Map();
  // Every block hash this node has accepted, so a rejected push can be told
  // apart from a duplicate of something we already have.
  let knownHashes = new Set(chain.blocks.map((block) => headerHash(block.header)));
  const seeds = (options.seeds ?? params.dnsSeeds ?? []).filter(Boolean);
  const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
  const discoveryIntervalMs =
    options.discoveryIntervalMs ?? SEED_DISCOVERY_INTERVAL_MS;
  const startedAt = Date.now();
  // Seed resolution is asynchronous, so a node that relies on it for peers has
  // not settled its sync yet even though its peer set is still empty.
  let syncSettled = peers.size === 0 && seeds.length === 0;
  let discovery = null;
  let discovering = false;
  let discoveryErrorKey = null;
  let syncing = false;
  // The startup pass gets one summary line once it has actually spoken to a
  // peer, so a seeded node reports the pass that included the peers it found.
  let startupSyncPending = true;
  // Recent switches to a heavier branch, newest first and read back from disk:
  // the newest one is what the explorer announces, and the rest are the history
  // an operator looks at after an overnight reorg. A file that cannot be read
  // simply starts the list empty rather than stopping the node.
  const switchHistoryFile = reorgHistoryFile(chainFile);
  let reorgHistory = loadReorgHistory({
    file: switchHistoryFile,
    network: params.name,
  });
  let syncQueued = false;
  // A peer that pushed a block we could not append, kept so the next pass asks
  // it first instead of fanning out to every peer.
  let syncQueuedPeer = null;
  let syncPreference = null;
  // The rejected push whose fork is still open, so the switch it leads to can
  // be timed. Cleared when the fork settles or the window passes.
  let forkWatch = null;
  let syncRequestTimer = null;
  let lastSyncRequestAt = 0;
  const reachabilityDelayMs =
    options.reachabilityDelayMs ?? REACHABILITY_FIRST_DELAY_MS;
  const reachabilityIntervalMs =
    options.reachabilityIntervalMs ?? REACHABILITY_INTERVAL_MS;
  let reachabilityFirstTimer = null;
  let reachabilityInterval = null;
  // A check pulled forward by a new peer, and whether one arrived while a check
  // was already in flight.
  let reachabilitySoonTimer = null;
  let reachabilityQueued = false;
  let reachability = null;
  let checkingReachability = false;
  // Seam for tests: the real one reads this machine's interfaces.
  const findRoutableAddress = options.routableAddress ?? routableAddress;
  const announceRefreshMs =
    options.announceRefreshMs ?? ANNOUNCE_REFRESH_INTERVAL_MS;
  let announceRefreshTimer = null;
  // Set while the chosen interface is without an address, so the warning above
  // is logged once per outage rather than on every refresh tick.
  let announceInterfaceMissing = false;

  let minerAddress =
    options.minerAddress ?? wallet?.defaultKey()?.address ?? null;
  let mining = Boolean(options.mine);
  // Bumped on every start/stop so a miner that was aborted mid-hash can tell
  // it has been superseded and exit, rather than racing a newer mine loop.
  let mineGeneration = 0;
  let activeMiner = null;
  let stopped = false;

  // Manual backups are asynchronous: the POST starts one and answers with a job
  // id, so the explorer can keep rendering (and a slow verification cannot hold
  // an HTTP connection open). Only the newest few jobs are kept.
  const backupJobs = new Map();
  let lastBackupJob = null;

  function snapshotBackupJob(job) {
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      state: job.state,
      requestedAt: job.requestedAt,
      finishedAt: job.finishedAt ?? null,
      // Where an export was asked to land; null for a retention-directory run.
      destination: job.destination ?? null,
      progress: job.progress ?? null,
      // The archive a cancelled run had to throw away, when there was one.
      discarded: job.discarded ?? null,
      backup: job.backup ?? null,
      error: job.error ?? null,
    };
  }

  /** Keep the last few jobs so a page reload can still find the one it started. */
  function rememberBackupJob(job) {
    backupJobs.set(job.id, job);
    lastBackupJob = job;
    for (const [id, tracked] of backupJobs) {
      if (backupJobs.size <= MAX_BACKUP_JOBS) {
        break;
      }
      if (tracked.state !== 'running') {
        backupJobs.delete(id);
      }
    }
  }

  // One thread for every archive this node writes or verifies, started on the
  // first job and reused after that. Unused when no backup directory is set.
  const backupWorker = createBackupWorker();

  // SHA-256 of each retained archive, so an operator can check what they saved.
  // Keyed by name and remembered with the size/mtime it was computed for, so a
  // rewritten archive is re-hashed and a five-second panel refresh costs a map
  // lookup instead of reading every file again. Hashing runs one file at a time
  // in the background: a listing reports the sums already known and the next
  // refresh picks up the rest.
  const archiveSums = new Map();
  const sumQueue = [];
  const sumQueued = new Set();
  let hashingSums = false;

  const backupSchedule = options.backup
    ? startBackupSchedule({
        params,
        chainFile,
        walletFile: options.walletFile ?? wallet?.file,
        directory: options.backup.directory,
        passphrase: options.backup.passphrase,
        firstDelayMs: options.backup.firstDelayMs,
        firstMaxWaitMs: options.backup.firstMaxWaitMs,
        firstReady: () => syncSettled,
        // Lets the schedule warn when its newest archive falls behind the chain
        // it is supposed to represent.
        tipHeight: () => chain.height,
        // Compressing and validating an archive is CPU-bound for seconds on a
        // real chain; doing it here would stall peer sync, mining and the API.
        runBackup: (job) => backupWorker.runBackup(job),
        // Reading an archive back is as CPU-bound as writing it, so the periodic
        // restore check runs off the event loop too.
        verifyBackup: (job) => backupWorker.verifyBackup(job),
        verifyIntervalMs: options.backup.verifyIntervalMs,
        intervalMs: options.backup.intervalMs,
        maxAgeMs: options.backup.maxAgeMs,
        maxLagBlocks: options.backup.maxLagBlocks,
        retention: options.backup.retention,
        recoveryHistoryLimit: options.backup.recoveryHistoryLimit,
      })
    : null;

  const explorer = fs.readFileSync(EXPLORER_FILE);
  const coin = fs.readFileSync(COIN_FILE);

  const wildcardHost = host === '0.0.0.0' || host === '::';
  // Replaced with the real bound port once the server is listening, which
  // matters when the caller asked for port 0.
  let selfUrl = `http://${wildcardHost ? '127.0.0.1' : host}:${port}`;
  // The URL peers are told to use. It differs from selfUrl whenever this
  // machine is reachable under a different address than the one it bound.
  let announceUrl = selfUrl;

  if (options.announce !== undefined && options.announce !== null) {
    if (options.announceInterface !== undefined && options.announceInterface !== null) {
      throw new Error(
        '--announce and --announce-interface cannot both be given: --announce states the address outright, --announce-interface picks one of this machine\'s addresses',
      );
    }
    if (announceUrlFor(options.announce, port > 0 ? port : params.defaultPort) === null) {
      throw new Error(
        `--announce must be a host, host:port or http://host:port (got "${options.announce}")`,
      );
    }
  }

  // The interface a wildcard-bound node announces from, when the operator
  // named one. Resolved now so a typo fails at startup instead of leaving every
  // peer with an address nothing answers on.
  const announceInterface =
    options.announceInterface === undefined || options.announceInterface === null
      ? null
      : String(options.announceInterface).trim();
  if (announceInterface !== null && announceInterface.length === 0) {
    throw new Error(
      '--announce-interface requires a network interface name such as eth0 or en0',
    );
  }
  if (announceInterface !== null) {
    if (!wildcardHost) {
      // The bind address is already the answer, so the interface would be
      // ignored; say so instead of letting the flag look effective.
      console.warn(
        `warning: --announce-interface applies to a wildcard bind; this node is bound to ${host} and announces it`,
      );
    }
    const address = findRoutableAddress(announceInterface);
    if (address === null && wildcardHost) {
      // Already said; the refresh tick should not repeat it every interval.
      announceInterfaceMissing = true;
      console.warn(
        `warning: interface ${announceInterface} has no routable IPv4 address; announcing the loopback address until it gets one`,
      );
    }
  }

  function countPeerBytes(peer, sent, received) {
    const entry = peerTraffic.get(peer) ?? {
      sent: 0,
      received: 0,
      requests: 0,
      lastAt: null,
    };
    entry.sent += sent;
    entry.received += received;
    entry.requests += 1;
    entry.lastAt = new Date().toISOString();
    peerTraffic.set(peer, entry);
  }

  /**
   * Every request this node makes of a peer goes through here, so the totals
   * cover sync, block and transaction pushes, peer announcements and
   * reachability probes alike. The body is read here to measure it and handed
   * back as a response, so callers keep using `json()` and `text()` as before.
   */
  async function peerFetch(peer, endpoint, init = {}) {
    const response = await fetch(`${peer}${endpoint}`, init);
    const text = await response.text();
    const sent = typeof init.body === 'string' ? Buffer.byteLength(init.body) : 0;
    countPeerBytes(peer, sent, Buffer.byteLength(text));
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Per-peer totals, busiest first, plus the sum across every peer this node
   * has spoken to. The peer's URL is the identity: one node, one entry.
   */
  function peerTrafficSnapshot() {
    const entries = [...peerTraffic.entries()]
      .map(([peer, traffic]) => ({
        peer,
        connected: peers.has(peer),
        sent: traffic.sent,
        received: traffic.received,
        // Both directions, so the busiest peer is the one that costs the most.
        total: traffic.sent + traffic.received,
        requests: traffic.requests,
        lastAt: traffic.lastAt,
      }))
      .sort((left, right) => right.total - left.total);
    return {
      sent: entries.reduce((sum, entry) => sum + entry.sent, 0),
      received: entries.reduce((sum, entry) => sum + entry.received, 0),
      peers: entries,
    };
  }

  /**
   * Send to every peer and return the ones that accepted the request. Each
   * request names this node, so a peer that cannot append a pushed block knows
   * which peer to ask for the chain instead of asking all of them.
   */
  async function broadcast(endpoint, payload) {
    const body = JSON.stringify(payload);
    const delivered = await Promise.all(
      [...peers].map(async (peer) => {
        try {
          await peerFetch(peer, endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [PEER_HEADER]: announceUrl,
            },
            body,
            signal: AbortSignal.timeout(5000),
          });
          return peer;
        } catch {
          // Peer offline; the periodic sync will catch it up later.
          return null;
        }
      }),
    );
    return delivered.filter(Boolean);
  }

  function relay(endpoint, payload, label, level = 'blocks') {
    broadcast(endpoint, payload).then((delivered) => {
      // A broadcast still in flight when the node stops has nowhere useful to
      // log to, and shutdown has already been reported.
      if (!stopped && delivered.length > 0) {
        log(level, `relayed ${label} to ${formatPeers(delivered.length)}`);
      }
    });
  }

  /**
   * Tell every peer where this node can be reached. Returns the peers that
   * accepted the announcement, so a caller that changed the address can report
   * where it got through and re-probe the new address without waiting for the
   * ten-minute reachability cycle.
   */
  function announceSelf() {
    return broadcast('/api/peers', { peer: announceUrl });
  }

  async function discoverPeers() {
    if (discovering || stopped || seeds.length === 0) {
      return discovery;
    }

    discovering = true;
    try {
      const result = await discoverSeedPeers({
        seeds,
        defaultPort: port,
        timeoutMs: options.seedTimeoutMs,
        lookup: options.seedLookup,
      });

      let added = 0;
      for (const peer of result.peers) {
        if (peer === selfUrl || peer === announceUrl || peers.has(peer)) {
          continue;
        }
        if (peers.size >= maxPeers) {
          break;
        }
        peers.add(peer);
        added += 1;
      }

      discovery = {
        at: new Date().toISOString(),
        seeds: result.seeds,
        resolved: result.resolved,
        found: result.peers.length,
        added,
        errors: result.errors,
      };

      if (added > 0) {
        log('blocks',
          `DNS seed discovery: ${added} new peer${
            added === 1 ? '' : 's'
          } from ${result.resolved.join(', ')}`,
        );
        // A discovered peer may be ahead of this node, so a first automatic
        // backup should keep waiting until the next sync pass finishes.
        syncSettled = false;
        announceSelf();
        syncPeers();
        checkReachabilitySoon();
      } else if (result.errors.length > 0) {
        // A seed host that never resolves would otherwise repeat the same
        // warning every few minutes, so only log when the failures change.
        const key = result.errors
          .map((entry) => `${entry.seed}:${entry.error}`)
          .join('|');
        if (key !== discoveryErrorKey) {
          discoveryErrorKey = key;
          const detail = result.errors
            .map((entry) => `${entry.seed} (${entry.error})`)
            .join(', ');
          console.error(`DNS seed discovery: no peers resolved from ${detail}`);
        }
      }

      return discovery;
    } finally {
      discovering = false;
    }
  }

  /**
   * Blocks we already have, newest first: the ten most recent, then
   * exponentially older ones back to genesis. Enough for a peer to find a
   * shared block even when the chains forked several blocks back.
   */
  function buildLocator() {
    const locator = [];
    let step = 1;
    for (
      let height = chain.height;
      height > 0 && locator.length < 32;
      height -= step
    ) {
      locator.push(headerHash(chain.blocks[height].header));
      if (locator.length >= 10) {
        step *= 2;
      }
    }
    locator.push(headerHash(chain.blocks[0].header));
    return locator;
  }

  async function syncPeers(preferred = null) {
    if (syncing) {
      syncQueued = true;
      syncQueuedPeer ??= preferred;
      return;
    }
    syncing = true;
    // Totals for this pass, for the one-line startup summary.
    let passBlocks = 0;
    let passBytes = 0;
    let passPeers = 0;
    // The peer that pushed a block this node could not append goes first: it
    // evidently holds a branch we lack, so its chain usually settles the fork
    // on its own, and the rest of the peers are only asked if it does not.
    const order =
      preferred && peers.has(preferred)
        ? [preferred, ...[...peers].filter((peer) => peer !== preferred)]
        : [...peers];
    try {
      for (const peer of order) {
        try {
          const locator = buildLocator().join(',');
          const response = await peerFetch(
            peer,
            `/api/chain?locator=${encodeURIComponent(locator)}`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (!response.ok) {
            continue;
          }
          // Read the body once as text so the log can report the bytes this
          // peer sync actually cost, not just what was adopted.
          const body = await response.text();
          const bytes = Buffer.byteLength(body);
          // Counted before the early exits below: an up-to-date peer still
          // costs a response, and the startup summary should say so.
          passBytes += bytes;
          passPeers += 1;
          const payload = JSON.parse(body);
          if (!Array.isArray(payload.blocks)) {
            continue;
          }
          if (payload.blocks.length === 0) {
            continue;
          }

          // A current peer answers with blocks after the shared height; an
          // older one answers with the whole chain. A suffix goes straight to
          // adopt(), which checks the link and measures the work, so sync never
          // builds the merged chain array itself.
          const from =
            Number.isInteger(payload.from) &&
            payload.from >= 0 &&
            payload.from < chain.blocks.length
              ? payload.from
              : null;

          // Where this node stood before adopting, so a switch can report the
          // branch that lost and not only the one that arrived.
          const before = {
            height: chain.height,
            tip: headerHash(chain.tip.header),
            work: chain.work,
          };

          const result =
            from === null
              ? chain.adopt(payload.blocks)
              : chain.adopt(payload.blocks, { from });
          if (result.added > 0) {
            // Named on the log line below, so a switch is readable from the log
            // alone: an operator watching a node needs the fork point, both
            // tips and how much heavier the winner was, not just "a reorg".
            let reorgNote = '';
            if (result.reorg) {
              // Both branches share everything up to the fork, so the work of
              // our abandoned blocks is our old total minus the shared prefix.
              const sharedWork = chain.work - chain.workAbove(result.fork);
              const entry = {
                at: new Date().toISOString(),
                forkHeight: result.fork,
                height: result.height,
                tip: headerHash(chain.tip.header),
                peer,
                added: result.added,
                dropped: (result.dropped ?? []).length,
                // The branch this node was on and left: its tip, the work it
                // had accumulated, and the work of the blocks it lost.
                lost: {
                  height: before.height,
                  hash: before.tip,
                  work: before.work.toString(),
                  workAboveFork: (before.work - sharedWork).toString(),
                },
                // How much heavier the adopted branch was, as exact work.
                gained: (chain.work - before.work).toString(),
              };
              try {
                reorgHistory = appendReorg({
                  file: switchHistoryFile,
                  network: params.name,
                  entry,
                });
              } catch (error) {
                // The switch is already applied; losing the record of it is
                // not worth failing the sync, but the list must stay current.
                console.error(
                  `could not record the chain switch: ${error.message}`,
                );
                reorgHistory = [entry, ...reorgHistory].slice(
                  0,
                  REORG_HISTORY_LIMIT,
                );
              }
              // The branch changed below the tip: drop the blocks that lost,
              // which adopt reports by hash, rather than rehashing every block
              // we kept.
              for (const hash of result.dropped ?? []) {
                knownHashes.delete(hash);
              }
              reorgNote =
                ` · reorg at fork #${entry.forkHeight}: ` +
                `#${entry.lost.height} ${entry.lost.hash.slice(0, 12)}… → ` +
                `#${entry.height} ${entry.tip.slice(0, 12)}…, ` +
                `+${entry.gained} work`;
            }
            // A straight extension keeps every hash we already know, and a
            // reorg keeps everything below the fork: either way only the blocks
            // above it are new.
            for (const block of chain.blocks.slice(
              chain.height - result.added + 1,
            )) {
              knownHashes.add(headerHash(block.header));
            }
            passBlocks += result.added;
            saveChain(chain, chainFile);
            activeMiner?.abort();
            log('blocks',
              `synced ${result.added} block(s), ${formatBytes(bytes)} from ${peer}${reorgNote}`,
            );
            reportForkSettled(result);
            if (peer === preferred) {
              // The fork that prompted this pass is settled, so there is nothing
              // to learn from the other peers that the next periodic pass will
              // not also find.
              break;
            }
          }
        } catch {
          // Unreachable or malicious peer: ignore and keep our chain.
        }
      }
      // One summary instead of only the per-peer lines, so the result of
      // starting up is a single line to look for in the log.
      if (startupSyncPending && passPeers > 0) {
        startupSyncPending = false;
        log('blocks',
          passBlocks > 0
            ? `startup sync: ${passBlocks} block(s), ${formatBytes(passBytes)} from ${formatPeers(passPeers)} · height ${chain.height}`
            : `startup sync: up to date at height ${chain.height} (${formatBytes(passBytes)} from ${formatPeers(passPeers)})`,
        );
      }
      // The initial pass has finished, so a first backup can now represent a
      // chain that has caught up with the peers we know about.
      syncSettled = true;
    } finally {
      syncing = false;
      if (syncQueued && !stopped) {
        syncQueued = false;
        const queuedPeer = syncQueuedPeer;
        syncQueuedPeer = null;
        requestSync(250, queuedPeer);
      }
    }
  }

  /**
   * Fetch the peers' chains soon instead of waiting for the periodic pass.
   * A peer that pushes a block we cannot append is probably on a heavier
   * branch, and leaving the fork standing for up to twenty seconds is the
   * difference between converging quickly and mining on a doomed tip. Bursts
   * are coalesced into one fetch.
   */
  function requestSync(delayMs = 250, prefer = null) {
    if (prefer && peers.has(prefer)) {
      // Recorded even when a pass is already scheduled: the sender still goes
      // first when that pass runs.
      syncPreference ??= prefer;
    }
    if (stopped || peers.size === 0 || syncRequestTimer) {
      return false;
    }
    // The first fetch after a rejected push is effectively immediate; repeats
    // are spaced out so a fork between two active miners cannot become a storm
    // of full-chain downloads.
    const wait = Math.max(
      delayMs,
      SYNC_REQUEST_MIN_INTERVAL_MS - (Date.now() - lastSyncRequestAt),
    );
    lastSyncRequestAt = Date.now();
    syncRequestTimer = setTimeout(() => {
      syncRequestTimer = null;
      const preferred = syncPreference;
      syncPreference = null;
      syncPeers(preferred);
    }, wait);
    syncRequestTimer.unref?.();
    return true;
  }

  function isKnownBlock(block) {
    try {
      return knownHashes.has(headerHash(block.header));
    } catch {
      return false;
    }
  }

  /**
   * How long the node took to move onto the heavier chain after refusing a
   * pushed block. Only a switch counts — a plain extension does not settle a
   * fork — and only inside the watch window, so a reorg that happens much later
   * is left to its own record instead of being charged to this rejection.
   */
  function reportForkSettled(result) {
    if (!result.reorg || !forkWatch) {
      return;
    }
    const elapsed = Date.now() - forkWatch.at;
    if (elapsed > FORK_WATCH_MS) {
      forkWatch = null;
      return;
    }
    log('blocks',
      `adopted the heavier chain ${elapsed} ms after rejecting block ${forkWatch.hash.slice(0, 12)}… from ${forkWatch.peer}`,
    );
    forkWatch = null;
  }

  /**
   * The URL of the peer that pushed a request, when it can be told. This node's
   * own relays name themselves; a sender that does not (an older node, or curl)
   * is matched by the address the request came from, but only when exactly one
   * peer lives there. Either way the answer is a peer already in `peers`: the
   * header arrives over plain HTTP, so it must not let anyone point the node at
   * a URL of their choosing.
   */
  function senderPeer(request) {
    const claimed = normalizePeerUrl(request.headers?.[PEER_HEADER]);
    if (claimed) {
      const known = [...peers].find(
        (peer) => normalizePeerUrl(peer) === claimed,
      );
      if (known) {
        return known;
      }
    }
    const remote = normalizeHost(request.socket?.remoteAddress);
    const matches = [...peers].filter(
      (peer) => normalizeHost(hostOfPeer(peer)) === remote,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function summarizeAddress(address) {
    decodeAddress(address, params.addressVersion);
    const nextHeight = chain.height + 1;
    let confirmed = 0n;
    let spendable = 0n;
    let pending = 0n;

    for (const utxo of chain.utxosFor(address)) {
      confirmed += utxo.value;
      if (
        !utxo.coinbase ||
        nextHeight - utxo.height >= params.coinbaseMaturity
      ) {
        spendable += utxo.value;
      }
    }

    for (const transaction of chain.mempool.values()) {
      for (const output of transaction.outputs) {
        if (output.address === address) {
          pending += BigInt(output.value);
        }
      }
    }

    return {
      address,
      confirmed: formatAmount(confirmed),
      spendable: formatAmount(spendable),
      pending: formatAmount(pending),
      utxos: chain.utxosFor(address).map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: formatAmount(utxo.value),
        height: utxo.height,
        coinbase: utxo.coinbase,
        mature:
          !utxo.coinbase ||
          nextHeight - utxo.height >= params.coinbaseMaturity,
      })),
    };
  }

  /**
   * The SHA-256 of one retained archive, or null while it is still being read.
   * The sum is remembered against the file's size and mtime, so an archive that
   * was rewritten is hashed again rather than reported with its old digest.
   */
  function checksumFor(directory, archive) {
    const key = `${archive.bytes}:${archive.mtimeMs}`;
    const known = archiveSums.get(archive.name);
    if (known?.key === key) {
      return known.sha256;
    }
    if (!sumQueued.has(archive.name)) {
      sumQueued.add(archive.name);
      sumQueue.push({
        name: archive.name,
        key,
        file: path.join(directory, archive.name),
      });
      hashQueuedArchives();
    }
    return null;
  }

  async function hashQueuedArchives() {
    if (hashingSums) {
      return;
    }
    hashingSums = true;
    try {
      while (sumQueue.length > 0 && !stopped) {
        const job = sumQueue.shift();
        sumQueued.delete(job.name);
        try {
          const sha256 = await sha256OfFile(job.file);
          archiveSums.set(job.name, { key: job.key, sha256 });
        } catch {
          // Unreadable or pruned while queued; the next listing retries.
        }
      }
    } finally {
      hashingSums = false;
    }
  }

  async function route(request, response) {
    const url = new URL(
      request.url,
      `http://${request.headers.host ?? 'localhost'}`,
    );
    const pathname = url.pathname;
    const method = request.method ?? 'GET';

    // Operator controls are not part of the peer protocol: a node bound beyond
    // loopback still syncs, but only this machine (or a caller holding the token
    // the node was started with) can pause mining or run a backup, and the
    // archives leave only when remote downloads were allowed. Checked before any
    // handler so no route can forget the rule.
    const refusal = controlRefusalReason(
      {
        method,
        pathname,
        remoteAddress: request.socket?.remoteAddress,
        authorization: request.headers?.authorization,
      },
      apiToken,
      { allowRemoteDownloads },
    );
    if (refusal !== null) {
      noteControlRefusal(method, pathname);
      sendJson(response, 403, { error: refusal });
      return;
    }

    if (method === 'GET' && pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(explorer);
      return;
    }

    if (method === 'GET' && pathname === '/assets/doubloom.svg') {
      response.writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=3600',
      });
      response.end(coin);
      return;
    }

    if (method === 'GET' && pathname === '/api/info') {
      sendJson(response, 200, {
        network: params.name,
        ticker: params.ticker,
        symbol: params.symbol,
        height: chain.height,
        bestBlockHash: headerHash(chain.tip.header),
        time: chain.tip.header.time,
        difficulty: chain.difficulty(),
        // Decimal string: cumulative work is far larger than a JS number can
        // hold once difficulty rises, so it is serialised as BigInt text.
        work: chain.work.toString(),
        supply: formatAmount(chain.circulatingSupply),
        maxSupply: formatAmount(params.maxMoney),
        nextSubsidy: formatAmount(subsidyAt(params, chain.height + 1)),
        mempool: chain.mempool.size,
        peers: peers.size,
        // The last time a peer was asked to dial this node's announced address,
        // or null before the first check (and again after the address changes).
        reachability,
        // Running totals for this process, per peer and summed. Only the
        // requests this node makes are counted, since an inbound push carries
        // no peer identity beyond its source address.
        peerTraffic: peerTrafficSnapshot(),
        seeds: seeds.length,
        discovery,
        mining,
        startedAt,
        // Which process is answering, so a second node on the same machine
        // can be told apart from this one by its explorer or backup panel.
        pid: process.pid,
        // The most recent switch, null until this node adopts a heavier branch
        // than its own. Derived from the history so the notice and the list can
        // never disagree, including after a restart.
        lastReorg: reorgHistory[0] ?? null,
        // Newest first, bounded, and kept on disk next to the chain.
        reorgHistory,
        explorer: selfUrl,
        announce: announceUrl,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/reachability') {
      const body = await readJson(request, 10_000);
      const target =
        typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : '';
      if (!/^https?:\/\/[^\s/]+/i.test(target)) {
        sendJson(response, 400, {
          error: 'send {"url": "http://host:port"} to check',
        });
        return;
      }
      const result = await probeNodeUrl(target);
      sendJson(response, 200, { url: target, ...result });
      return;
    }

    if (method === 'GET' && pathname === '/api/mining') {
      sendJson(response, 200, {
        mining,
        address: minerAddress,
        height: chain.height,
        difficulty: chain.difficulty(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/mining') {
      const body = await readJson(request, 10_000);
      if (typeof body.enabled !== 'boolean') {
        sendJson(response, 400, {
          error: 'send {"enabled": true} to resume or {"enabled": false} to pause',
        });
        return;
      }
      // Mining needs somewhere to pay the subsidy, so refusing here is clearer
      // than accepting the request and silently doing nothing.
      if (body.enabled && !minerAddress) {
        sendJson(response, 409, {
          error: 'no mining address; start the node with --address',
        });
        return;
      }
      const changed = setMining(body.enabled);
      if (changed) {
        log('blocks',
          body.enabled
            ? `mining resumed via API to ${minerAddress}`
            : `mining paused via API at height ${chain.height}`,
        );
      }
      sendJson(response, 200, {
        ok: true,
        changed,
        mining,
        address: minerAddress,
        height: chain.height,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/backup') {
      if (!backupSchedule) {
        sendJson(response, 200, { enabled: false, job: null, archives: [] });
        return;
      }
      // The most recent job rides along, so a page that reloaded mid-backup can
      // pick the job up again instead of starting a second one, and the archives
      // on disk are listed so any of them can be downloaded, not just the newest.
      // Each carries its SHA-256 once that file has been read, which is what an
      // operator compares their saved copy against.
      const directory = backupSchedule.directory;
      const archives = listArchives({ directory, network: params.name });
      // Drop sums for archives retention has removed.
      const retained = new Set(archives.map((archive) => archive.name));
      for (const name of archiveSums.keys()) {
        if (!retained.has(name)) {
          archiveSums.delete(name);
        }
      }
      sendJson(response, 200, {
        ...backupSchedule.status(),
        job: snapshotBackupJob(lastBackupJob),
        archives: archives.map((archive) => ({
          name: archive.name,
          bytes: archive.bytes,
          at: archive.at,
          sha256: checksumFor(directory, archive),
        })),
      });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/backup/jobs/')) {
      const id = decodeURIComponent(pathname.slice('/api/backup/jobs/'.length));
      const job = backupJobs.get(id);
      if (!job) {
        sendJson(response, 404, { error: `unknown backup job: ${id}` });
        return;
      }
      sendJson(response, 200, { job: snapshotBackupJob(job) });
      return;
    }

    // Stop a run: the worker thread is terminated, whatever it wrote is deleted,
    // and the job settles as `cancelled` rather than `failed`. The response is
    // held until that has happened, so a client is never told "cancelled" while
    // an unverified archive is still on disk.
    if (method === 'DELETE' && pathname.startsWith('/api/backup/jobs/')) {
      const id = decodeURIComponent(pathname.slice('/api/backup/jobs/'.length));
      const job = backupJobs.get(id);
      if (!job) {
        sendJson(response, 404, { error: `unknown backup job: ${id}` });
        return;
      }
      if (job.state !== 'running') {
        sendJson(response, 409, {
          error: `the backup already ${job.state === 'succeeded' ? 'finished' : job.state}`,
          job: snapshotBackupJob(job),
        });
        return;
      }
      if (!backupWorker.cancelRunning()) {
        sendJson(response, 409, {
          error: 'no backup is running',
          job: snapshotBackupJob(job),
        });
        return;
      }
      // Bounded: a thread that refuses to stop must not hold the request open.
      await Promise.race([
        job.done,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      sendJson(response, 200, {
        ok: true,
        job: snapshotBackupJob(job),
        status: backupSchedule?.status() ?? null,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/backup') {
      if (!backupSchedule) {
        sendJson(response, 409, {
          error: 'automatic backups are not enabled',
        });
        return;
      }

      // One archive at a time: a second request joins the run already in flight
      // rather than stacking a duplicate archive on a slow chain.
      const inFlight = [...backupJobs.values()].find(
        (job) => job.state === 'running',
      );
      if (inFlight) {
        sendJson(response, 409, {
          error: 'a backup is already running',
          job: snapshotBackupJob(inFlight),
          status: backupSchedule.status(),
        });
        return;
      }

      // An optional destination turns the run into an export: the archive is
      // written where the caller asked, outside the directory the schedule owns.
      // Nothing until now read a body here, so an empty request is still valid.
      const body = await readJson(request, 10_000).catch(() => ({}));
      const destination =
        typeof body?.destination === 'string' ? body.destination : null;

      const job = {
        id: randomUUID(),
        state: 'running',
        requestedAt: new Date().toISOString(),
        finishedAt: null,
        destination,
        // Blocks written and re-verified, as the worker reports them; null
        // until the first message, so a client can tell "no figure yet" from
        // "nothing done".
        progress: null,
        backup: null,
        error: null,
      };

      let pending;
      try {
        pending = backupSchedule.runNow({
          destination,
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
      } catch (error) {
        // Synchronous guards (a stopped schedule, or a scheduled run that got
        // there first): report it instead of handing out a job that never ran.
        job.state = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error.message;
        rememberBackupJob(job);
        // A rejected destination is the caller's mistake, not the node's; a
        // busy or stopped schedule is a conflict.
        const status = /already running|stopped/.test(error.message)
          ? 409
          : /destination/.test(error.message)
            ? 400
            : 500;
        sendJson(response, status, {
          error: error.message,
          job: snapshotBackupJob(job),
          status: backupSchedule.status(),
        });
        return;
      }

      rememberBackupJob(job);
      // Kept on the job so a cancel request can wait for the run to settle — and
      // for the archive it wrote to be removed — before it answers.
      job.done = Promise.resolve(pending).then(
        (result) => {
          job.state = 'succeeded';
          job.finishedAt = new Date().toISOString();
          job.backup = {
            ...result,
            // An export never becomes the schedule's last backup, so it reports
            // when it finished rather than borrowing that archive's timestamp.
            at: destination
              ? job.finishedAt
              : (backupSchedule.status().lastBackup?.at ?? null),
          };
        },
        (error) => {
          job.finishedAt = new Date().toISOString();
          if (error?.cancelled) {
            // Stopped by an operator: not a failure, and the file it left is
            // already gone. `discarded` names it so the caller can say so.
            job.state = 'cancelled';
            job.discarded = error.discarded ?? null;
            return;
          }
          job.state = 'failed';
          job.error = error.message;
        },
      );

      // 202: the archive is being written and verified; poll the job to follow it.
      sendJson(response, 202, {
        ok: true,
        job: snapshotBackupJob(job),
        status: backupSchedule.status(),
      });
      return;
    }

    // Download the newest verified archive. Only the file the schedule recorded
    // is served, and only when it sits directly in the configured backup
    // directory, so this endpoint cannot be pointed at another path on the
    // host. The file stays where it is; this is a copy, not a move.
    // Download one retained archive by name. The name must be one this network
    // writes and must resolve directly inside the backup directory, so neither
    // a traversal nor an unrelated file in that directory can be fetched.
    if (method === 'GET' && pathname.startsWith('/api/backup/archives/')) {
      if (!backupSchedule) {
        sendJson(response, 409, {
          error: 'automatic backups are not enabled',
        });
        return;
      }

      const name = decodeURIComponent(
        pathname.slice('/api/backup/archives/'.length),
      );
      const directory = path.resolve(backupSchedule.directory);
      const known = listArchives({ directory, network: params.name }).some(
        (archive) => archive.name === name,
      );
      if (!known) {
        sendJson(response, 404, {
          error: `no backup archive named ${name}`,
        });
        return;
      }

      const file = path.resolve(directory, name);
      if (path.dirname(file) !== directory) {
        sendJson(response, 403, {
          error: 'backup archive is outside the backup directory',
        });
        return;
      }

      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        sendJson(response, 404, {
          error: `backup archive is missing: ${name}`,
        });
        return;
      }

      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': size,
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return;
    }

    if (method === 'GET' && pathname === '/api/backup/download') {
      if (!backupSchedule) {
        sendJson(response, 409, {
          error: 'automatic backups are not enabled',
        });
        return;
      }

      const lastBackup = backupSchedule.status().lastBackup;
      if (!lastBackup?.path) {
        sendJson(response, 404, {
          error: 'no verified backup archive yet',
        });
        return;
      }

      const directory = path.resolve(backupSchedule.directory);
      const file = path.resolve(lastBackup.path);
      if (path.dirname(file) !== directory) {
        sendJson(response, 403, {
          error: 'backup archive is outside the backup directory',
        });
        return;
      }

      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        sendJson(response, 404, {
          error: `backup archive is missing: ${file}`,
        });
        return;
      }

      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': size,
        'content-disposition': `attachment; filename="${path.basename(file)}"`,
        'cache-control': 'no-store',
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return;
    }

    if (method === 'GET' && pathname === '/api/chain') {
      const locator = (url.searchParams.get('locator') ?? '')
        .split(',')
        .map((hash) => hash.trim())
        .filter(Boolean);

      if (locator.length === 0) {
        sendJson(response, 200, {
          network: params.name,
          height: chain.height,
          blocks: chain.blocks,
        });
        return;
      }

      // Bitcoin-style locator: the caller lists block hashes it already has,
      // newest first, and gets back only the blocks after the highest one we
      // share. Syncing at the tip therefore transfers nothing, and a fork only
      // transfers the branch after the fork point.
      const heightsByHash = new Map(
        chain.blocks.map((block, height) => [headerHash(block.header), height]),
      );
      let from = null;
      for (const hash of locator) {
        const height = heightsByHash.get(hash);
        if (height !== undefined) {
          from = height;
          break;
        }
      }

      sendJson(response, 200, {
        network: params.name,
        height: chain.height,
        from,
        blocks: from === null ? chain.blocks : chain.blocks.slice(from + 1),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/blocks') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
      const blocks = chain.blocks
        .slice(-limit)
        .map((block, index) => summarizeBlock(block, chain.height - Math.min(limit, chain.blocks.length) + 1 + index))
        .reverse();
      sendJson(response, 200, { height: chain.height, blocks });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/blocks/')) {
      const identifier = decodeURIComponent(pathname.slice('/api/blocks/'.length));
      const height = /^\d+$/.test(identifier)
        ? Number(identifier)
        : chain.blocks.findIndex(
            (block) => headerHash(block.header) === identifier,
          );
      const block = chain.blocks[height];
      if (!block) {
        sendJson(response, 404, { error: 'block not found' });
        return;
      }
      sendJson(response, 200, {
        ...summarizeBlock(block, height),
        block,
      });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/tx/')) {
      const id = decodeURIComponent(pathname.slice('/api/tx/'.length));
      const height = chain.txIndex.get(id);
      const pending = chain.mempool.get(id);
      if (height === undefined && !pending) {
        sendJson(response, 404, { error: 'transaction not found' });
        return;
      }
      const transaction =
        pending ?? chain.blocks[height].transactions.find((tx) => txid(tx) === id);
      sendJson(response, 200, {
        txid: id,
        confirmed: pending ? false : true,
        height: pending ? null : height,
        confirmations: pending ? 0 : chain.height - height + 1,
        transaction,
      });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/address/')) {
      const address = decodeURIComponent(pathname.slice('/api/address/'.length));
      sendJson(response, 200, summarizeAddress(address));
      return;
    }

    if (method === 'GET' && pathname === '/api/mempool') {
      sendJson(response, 200, {
        count: chain.mempool.size,
        transactions: chain.mempoolEntries().map((entry) => ({
          txid: entry.id,
          fee: formatAmount(entry.fee),
          size: entry.size,
          feeRate: entry.feeRate,
          outputs: entry.transaction.outputs,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/peers') {
      sendJson(response, 200, { peers: [...peers] });
      return;
    }

    if (method === 'POST' && pathname === '/api/tx') {
      if (refuseThrottled(response, 'tx', request.socket?.remoteAddress)) {
        // Read and discard the body so the connection can be reused.
        request.resume();
        return;
      }
      const transaction = await readJson(request);
      const source = request.socket.remoteAddress ?? 'peer';
      // Accepted only, like blocks: a duplicate or conflicting transaction
      // throws out of addTransaction, so a peer echoing one we hold never
      // reaches the log line below.
      const result = chain.addTransaction(transaction);
      saveChain(chain, chainFile);
      sendJson(response, 200, {
        txid: result.txid,
        fee: formatAmount(result.fee),
        size: result.size,
        mempool: chain.mempool.size,
      });
      // Size and fee rate as well as the fee: the rate is what decides whether
      // a transaction would be relayed, so a log line without it cannot explain
      // why a marginal payment took as long as it did. The rate matches the
      // mempool's, which divides the same fee by the same byte count.
      const feeRate = Number(result.fee) / result.size;
      log(
        'full',
        `received tx ${result.txid} from ${source} (${
          transaction.inputs.length
        } in, ${transaction.outputs.length} out, ${formatAmount(
          result.fee,
        )} DBL fee, ${result.size} bytes, ${feeRate.toFixed(2)} petal/byte)`,
      );
      relay('/api/tx', transaction, `tx ${result.txid}`, 'full');
      return;
    }

    if (method === 'POST' && pathname === '/api/block') {
      const block = await readJson(request, 4_000_000);
      const source = request.socket.remoteAddress ?? 'peer';
      let result;
      try {
        result = chain.addBlock(block);
      } catch (error) {
        // A block we have never seen that does not extend our tip means the
        // sender is on a branch we do not know about. Ask that peer for its
        // chain now rather than leaving the fork standing until the periodic
        // sync — it is the one that evidently has something we lack. Only when
        // it cannot be told which peer it was does the fetch fan out to all of
        // them. Duplicates (a peer echoing one of our blocks back) are known
        // and must not trigger a fetch, or every relay would cause one.
        const known = isKnownBlock(block);
        if (!known) {
          const sender = senderPeer(request);
          // The clock starts at the first rejection of an open fork, so the
          // measurement covers the whole episode rather than the last echo of
          // it. An older watch belongs to a fork that is already gone.
          if (!forkWatch || Date.now() - forkWatch.at > FORK_WATCH_MS) {
            forkWatch = {
              at: Date.now(),
              hash: headerHash(block.header),
              peer: sender ?? source,
            };
          }
          if (requestSync(250, sender)) {
            log('blocks',
              sender
                ? `block ${headerHash(block.header)} from ${source} does not extend our tip; requesting the chain from ${sender}`
                : `block ${headerHash(block.header)} from ${source} does not extend our tip; requesting the peer chain`,
            );
          }
        }
        throw error;
      }
      knownHashes.add(result.hash);
      saveChain(chain, chainFile);
      activeMiner?.abort();
      log('blocks',
        `received block ${result.height} ${result.hash} from ${source} (${
          block.transactions.length
        } tx)`,
      );
      sendJson(response, 200, {
        height: result.height,
        hash: result.hash,
      });
      relay('/api/block', block, `block ${result.height}`);
      return;
    }

    if (method === 'POST' && pathname === '/api/peers') {
      if (refuseThrottled(response, 'peers', request.socket?.remoteAddress)) {
        request.resume();
        return;
      }
      const body = await readJson(request, 100_000);
      const listed = [
        ...(Array.isArray(body.peers) ? body.peers : []),
        ...(typeof body.peer === 'string' ? [body.peer] : []),
      ];
      let added = 0;
      for (const peer of listed) {
        if (
          /^https?:\/\/[^\s]+$/.test(peer) &&
          peer !== selfUrl &&
          peer !== announceUrl
        ) {
          const clean = peer.replace(/\/+$/, '');
          if (!peers.has(clean)) {
            added += 1;
          }
          peers.add(clean);
        }
      }
      if (added > 0) {
        // A peer that just introduced itself can test the announced address now.
        checkReachabilitySoon();
      }
      sendJson(response, 200, { peers: [...peers] });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 400, { error: error.message });
      } else {
        response.end();
      }
    });
  });

  /**
   * Ask one peer to dial the address this node announced. The log stays quiet
   * while the answer is unchanged, warns on every failed check (an ongoing
   * problem is worth repeating), and reports the recovery once.
   */
  async function checkReachability() {
    if (stopped || peers.size === 0 || checkingReachability) {
      return null;
    }
    checkingReachability = true;
    let result = null;
    try {
      result = await askPeerToDial();
    } finally {
      checkingReachability = false;
    }
    // A peer that arrived while this check was running gets its own attempt
    // rather than waiting out the interval.
    if (reachabilityQueued && !stopped) {
      reachabilityQueued = false;
      checkReachabilitySoon();
    }
    return result;
  }

  /**
   * A newly known peer is a new chance to prove the announced address works, so
   * the check is pulled forward instead of waiting for the periodic tick. Seed
   * discovery can add several peers in one pass, so the delay coalesces them
   * into a single check.
   */
  function checkReachabilitySoon() {
    if (stopped || peers.size === 0) {
      return false;
    }
    if (reachabilitySoonTimer) {
      return false;
    }
    if (checkingReachability) {
      reachabilityQueued = true;
      return false;
    }
    reachabilitySoonTimer = setTimeout(() => {
      reachabilitySoonTimer = null;
      checkReachability();
    }, PEER_CHECK_DELAY_MS);
    reachabilitySoonTimer.unref?.();
    return true;
  }

  async function askPeerToDial() {
    for (const peer of [...peers].slice(0, 3)) {
      let payload;
      try {
        const response = await peerFetch(peer, '/api/reachability', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: announceUrl }),
          signal: AbortSignal.timeout(8000),
        });
        // 404 means the peer predates this check; try the next one.
        if (!response.ok) {
          continue;
        }
        payload = await response.json();
      } catch {
        continue;
      }

      const previous = reachability;
      const result = {
        peer,
        url: announceUrl,
        reachable: payload?.reachable === true,
        error: typeof payload?.error === 'string' ? payload.error : null,
        // When the check ran, so a stale result can be told from a fresh one.
        at: new Date().toISOString(),
      };
      reachability = result;

      if (!result.reachable) {
        console.warn(
          `warning: peer ${peer} could not reach the announced address ${announceUrl} (${result.error ?? 'no response'}); check --announce, port forwarding and firewalls`,
        );
      } else if (previous === null || !previous.reachable) {
        // First successful check, or a recovery from a failed one.
        log('blocks', `announced address ${announceUrl} is reachable from ${peer}`);
      }
      return result;
    }

    return null;
  }

  /** Start or stop mining on a running node; returns whether state changed. */
  function setMining(enabled) {
    const next = Boolean(enabled);
    if (next === mining || stopped) {
      return false;
    }
    mining = next;
    mineGeneration += 1;
    if (mining) {
      mineLoop();
    } else {
      activeMiner?.abort();
    }
    return true;
  }

  async function mineLoop() {
    const generation = mineGeneration;
    if (!minerAddress) {
      console.error('mining is enabled but no wallet address is available');
      mining = false;
      return;
    }

    while (mining && !stopped && generation === mineGeneration) {
      const block = chain.buildBlock(minerAddress);
      const controller = new AbortController();
      activeMiner = controller;
      const header = await mineHeaderAsync(block.header, {
        signal: controller.signal,
      });

      if (!mining || stopped || generation !== mineGeneration) {
        break;
      }
      if (!header) {
        continue;
      }
      if (block.header.prevHash !== headerHash(chain.tip.header)) {
        continue;
      }

      try {
        const mined = chain.addBlock(block);
        knownHashes.add(mined.hash);
        saveChain(chain, chainFile);
        log('blocks',
          `mined block ${chain.height} ${mined.hash} (${
            block.transactions.length
          } tx, reward ${formatAmount(
            BigInt(block.transactions[0].outputs[0].value),
          )} DBL)`,
        );
        relay('/api/block', block, `block ${chain.height}`);
      } catch (error) {
        console.error(`mined block rejected: ${error.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Only the newest loop owns the handle; an older one exiting late must not
    // clear the miner that replaced it.
    if (generation === mineGeneration) {
      activeMiner = null;
    }
  }

  server.on('error', (error) => {
    console.error(`node error: ${error.message}`);
    process.exitCode = 1;
  });

  /** Persist where peers were told to find this node, next to the chain. */
  function recordNodeState() {
    const address = server.address();
    try {
      saveNodeState(nodeStateFile(chainFile), {
        network: params.name,
        pid: process.pid,
        url: selfUrl,
        announce: announceUrl,
        port:
          address && typeof address === 'object' ? address.port : port,
        startedAt: new Date(startedAt).toISOString(),
      });
    } catch (error) {
      console.error(`could not record the announced address: ${error.message}`);
    }
  }

  /**
   * Recompute the automatic announced address.
   *
   * Only a wildcard-bound node started without `--announce` has one to
   * recompute: it is an interface address, which changes when the host joins
   * another network or its DHCP lease moves. With `--announce-interface` that
   * is the named interface only. An explicit `--announce` is a deliberate
   * statement about port forwarding and is never overridden.
   */
  function refreshAnnouncedAddress() {
    if (stopped || !wildcardHost) {
      return null;
    }
    if (options.announce !== undefined && options.announce !== null) {
      return null;
    }
    const address = server.address();
    if (!address || typeof address !== 'object') {
      return null;
    }

    let routable;
    try {
      routable = findRoutableAddress(announceInterface ?? undefined);
    } catch (error) {
      console.error(`could not read network interfaces: ${error.message}`);
      return null;
    }
    if (routable === null && announceInterface !== null) {
      // A chosen interface that is momentarily down or between leases must not
      // demote the node to loopback: keep the last address that worked and say
      // so once per outage.
      if (!announceInterfaceMissing) {
        announceInterfaceMissing = true;
        console.warn(
          `warning: interface ${announceInterface} has no routable address; still announcing ${announceUrl} until it returns`,
        );
      }
      return null;
    }
    announceInterfaceMissing = false;
    const next = routable ? `http://${routable}:${address.port}` : selfUrl;
    if (next === announceUrl) {
      return null;
    }

    const previous = announceUrl;
    announceUrl = next;
    if (next === selfUrl) {
      console.warn(
        `warning: no routable address found; announcing ${next} until an interface returns (set --announce to pin one)`,
      );
    } else {
      log('blocks',
        `announced address changed from ${previous} to ${next} (network interface changed); re-announcing to peers`,
      );
    }
    // "doubloom info" and the explorer should show where peers are now told to
    // look, and the next reachability check has to probe this new address.
    recordNodeState();
    reachability = null;
    // Peers are told now, not on the next periodic pass: a peer still holding
    // the old address would keep handing it out in the meantime.
    announceSelf().then((delivered) => {
      if (stopped) {
        return;
      }
      if (delivered.length > 0) {
        log('blocks',
          `re-announced ${announceUrl} to ${formatPeers(delivered.length)}`,
        );
      }
      // The last reachability result describes an address this node no longer
      // uses, so ask a peer to dial the new one now. The check coalesces, so a
      // flapping interface still costs one probe.
      checkReachabilitySoon();
    });
    return announceUrl;
  }

  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      selfUrl = `http://${wildcardHost ? '127.0.0.1' : host}:${address.port}`;
      if (options.announce !== undefined && options.announce !== null) {
        announceUrl = announceUrlFor(options.announce, address.port);
      } else if (wildcardHost) {
        const routable = findRoutableAddress(announceInterface ?? undefined);
        announceUrl = routable
          ? `http://${routable}:${address.port}`
          : selfUrl;
      } else {
        announceUrl = selfUrl;
      }
    }
    log('blocks', `Doubloom ${params.name} node listening on ${selfUrl}`);
    log('blocks', `Block explorer: ${selfUrl}`);
    // Recorded next to the chain so `doubloom info` can report where peers
    // were told to find this node, which is not derivable from the chain file.
    recordNodeState();
    if (
      wildcardHost &&
      (options.announce === undefined || options.announce === null) &&
      Number.isFinite(announceRefreshMs) &&
      announceRefreshMs > 0
    ) {
      announceRefreshTimer = setInterval(refreshAnnouncedAddress, announceRefreshMs);
      announceRefreshTimer.unref?.();
    }
    if (announceUrl !== selfUrl) {
      log('blocks',
        `Announcing ${announceUrl} to peers${
          announceInterface === null ? '' : ` (interface ${announceInterface})`
        }`,
      );
    } else if (
      wildcardHost &&
      options.announce === undefined &&
      announceUrl === selfUrl
    ) {
      log('blocks',
        announceInterface === null
          ? 'No routable address found on this machine; announcing the loopback address (set --announce)'
          : `Interface ${announceInterface} has no routable address yet; announcing the loopback address until it gets one`,
      );
    }
    log('blocks', `Data file: ${chainFile}`);
    if (seeds.length > 0) {
      log('blocks', `DNS seeds: ${seeds.join(', ')} (up to ${maxPeers} peers)`);
    } else if (peers.size === 0) {
      log('blocks',
        'No DNS seeds configured and no peers given; add --seed or --peers',
      );
    }
    if (peers.size > 0) {
      log('blocks', `Peers: ${[...peers].join(', ')}`);
    }
    if (mining) {
      log('blocks', `Mining to ${minerAddress}`);
    }
    if (backupSchedule) {
      const minutes = Number((backupSchedule.intervalMs / 60_000).toFixed(3));
      const backupStatus = backupSchedule.status();
      const retention = backupStatus.retention;
      const tiers = ['hourly', 'daily', 'weekly']
        .filter((tier) => Number.isInteger(retention?.[tier]) && retention[tier] > 0)
        .map((tier) => `${retention[tier]} ${tier}`)
        .join(' · ');
      const verify =
        Number.isFinite(backupStatus.verifyIntervalMs) &&
        backupStatus.verifyIntervalMs > 0
          ? `, verify every ${formatBackupDelay(backupStatus.verifyIntervalMs)}`
          : ', verification off';
      // Zero is the explicit opt-out: wait for sync for as long as it takes.
      const syncWaitCap =
        Number.isFinite(backupStatus.firstMaxWaitMs) &&
        backupStatus.firstMaxWaitMs > 0
          ? `, sync wait cap ${formatBackupDelay(backupStatus.firstMaxWaitMs)}`
          : '';
      log('blocks',
        `Automatic backups: ${backupSchedule.directory} every ${minutes} min (keep ${tiers || 'nothing'}, recoveries ${backupStatus.recoveryHistoryLimit ?? 5}, max age ${formatBackupDelay(backupStatus.maxAgeMs)}, lag ${backupStatus.maxLagBlocks} block${
          backupStatus.maxLagBlocks === 1 ? '' : 's'
        }${verify}${syncWaitCap})`,
      );
      const lastBackup = backupStatus.lastBackup;
      if (lastBackup) {
        log('blocks',
          `Last automatic backup: ${lastBackup.at} (height ${lastBackup.height}) ${lastBackup.path}`,
        );
      }
      if (backupStatus.nextRunAt) {
        const firstDelay = Number.isFinite(backupStatus.firstDelayMs)
          ? ` (first delay ${formatBackupDelay(backupStatus.firstDelayMs)})`
          : '';
        log('blocks', `Next automatic backup: ${backupStatus.nextRunAt}${firstDelay}`);
      }
      if (!syncSettled) {
        const cap =
          Number.isFinite(backupStatus.firstMaxWaitMs) &&
          backupStatus.firstMaxWaitMs > 0
            ? ` for up to ${formatBackupDelay(backupStatus.firstMaxWaitMs)}, then backs up anyway`
            : ' indefinitely (--backup-first-max-wait 0)';
        log('blocks', `First automatic backup waits for peer sync to settle${cap}`);
      }
    }
    discoverPeers();
    announceSelf();
    syncPeers();

    reachabilityFirstTimer = setTimeout(checkReachability, reachabilityDelayMs);
    reachabilityFirstTimer.unref?.();
    reachabilityInterval = setInterval(
      checkReachability,
      reachabilityIntervalMs,
    );
    reachabilityInterval.unref?.();
  });

  const syncTimer = setInterval(syncPeers, 20_000);
  syncTimer.unref?.();

  const discoveryTimer =
    seeds.length > 0
      ? setInterval(discoverPeers, discoveryIntervalMs)
      : null;
  discoveryTimer?.unref?.();

  if (mining) {
    mineLoop();
  }

  return {
    server,
    peers,
    url: selfUrl,
    backups: backupSchedule,
    setMinerAddress(address) {
      minerAddress = address;
    },
    /** Start or stop mining on a running node; returns whether state changed. */
    setMining,
    /** Re-read the interfaces now; the periodic watch calls this too. */
    refreshAnnouncedAddress,
    async close() {
      mining = false;
      stopped = true;
      activeMiner?.abort();
      backupSchedule?.stop();
      // Waits for an archive being written when the node was asked to stop: a
      // terminated thread would leave a truncated backup behind.
      await backupWorker.close();
      clearInterval(syncTimer);
      if (syncRequestTimer) {
        clearTimeout(syncRequestTimer);
      }
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
      }
      if (reachabilityFirstTimer) {
        clearTimeout(reachabilityFirstTimer);
      }
      if (reachabilityInterval) {
        clearInterval(reachabilityInterval);
      }
      if (reachabilitySoonTimer) {
        clearTimeout(reachabilitySoonTimer);
        reachabilitySoonTimer = null;
      }
      reachabilityQueued = false;
      if (announceRefreshTimer) {
        clearInterval(announceRefreshTimer);
        announceRefreshTimer = null;
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
