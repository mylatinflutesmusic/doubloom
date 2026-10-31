import dns from 'node:dns';

/**
 * DNS seed discovery.
 *
 * A node with no peers is a private chain. Bitcoin solved bootstrap by
 * publishing well-known seed hostnames: the client resolves them at startup,
 * treats every returned address as a peer, and repeats periodically so that
 * dead addresses are replaced. Doubloom uses the same approach.
 *
 * Seeds are resolved at connect time, never trusted for anything else: an
 * address is only a hint about where a node might be listening.
 */

export const DEFAULT_SEED_TIMEOUT_MS = 4000;

/**
 * Parse one seed entry into a host and port.
 *
 * Accepted forms: `seed.example.org`, `seed.example.org:8338`,
 * `http://seed.example.org:8338/`, and `[::1]:8338`.
 * Returns null for entries that cannot be used, so a typo in one seed does not
 * discard the rest of the list.
 */
export function parseSeed(value, defaultPort) {
  if (typeof value !== 'string') {
    return null;
  }

  let entry = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (entry.length === 0) {
    return null;
  }

  let host = entry;
  let port = defaultPort;

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2] !== undefined) {
      port = Number(bracketed[2]);
    }
  } else if (entry.split(':').length === 2) {
    const colon = entry.indexOf(':');
    host = entry.slice(0, colon);
    port = Number(entry.slice(colon + 1));
  }

  if (host.length === 0 || /[\s/]/.test(host) || (!bracketed && host.includes(':'))) {
    // A bare IPv6 address without brackets is ambiguous with host:port, so it
    // is rejected rather than guessed at.
    return null;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return { host, port };
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        // Not unref'd: the timeout is the only thing that can settle a lookup
        // that never answers, so it must keep the loop alive until it fires.
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultLookup = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Resolve every seed and return peer URLs.
 *
 * Failures are collected instead of thrown: seeds are best-effort bootstrap
 * hints, and one unreachable host must not stop the node from trying the
 * others. `lookup` is injectable so the behaviour can be tested without
 * depending on real DNS.
 */
export async function discoverSeedPeers({
  seeds = [],
  defaultPort,
  timeoutMs = DEFAULT_SEED_TIMEOUT_MS,
  lookup = defaultLookup,
} = {}) {
  // Keep the caller's order so errors are reported in the order given.
  const entries = seeds.map((seed) => {
    const target = parseSeed(seed, defaultPort);
    return target ? { target } : { invalid: String(seed) };
  });

  const peers = [];
  const resolved = [];
  const errors = [];

  for (const entry of entries) {
    if (!entry.target) {
      errors.push({ seed: entry.invalid, error: 'not a usable host' });
      continue;
    }
    const target = entry.target;

    let addresses;
    try {
      addresses = await withTimeout(
        lookup(target.host),
        timeoutMs,
        `DNS lookup for ${target.host} timed out`,
      );
    } catch (error) {
      errors.push({
        seed: target.host,
        error: error.code ?? error.message ?? 'lookup failed',
      });
      continue;
    }

    const list = Array.isArray(addresses) ? addresses : [addresses];
    const usable = list.filter((entry) => entry && typeof entry.address === 'string');
    if (usable.length === 0) {
      errors.push({ seed: target.host, error: 'no addresses' });
      continue;
    }

    resolved.push(target.host);
    for (const { address } of usable) {
      const url = `http://${formatHost(address)}:${target.port}`;
      if (!peers.includes(url)) {
        peers.push(url);
      }
    }
  }

  return {
    peers,
    resolved,
    errors,
    seeds: entries
      .filter((entry) => entry.target)
      .map(
        (entry) => `${formatHost(entry.target.host)}:${entry.target.port}`,
      ),
  };
}
