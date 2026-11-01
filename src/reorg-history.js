import fs from 'node:fs';
import path from 'node:path';

/**
 * Recent chain switches, kept beside the chain.
 *
 * The node already knows the last switch it made, but only until it stops: a
 * reorg at 03:00 is exactly what an operator wants to look at in the morning,
 * and a restart in between must not erase it. Entries are appended to a small
 * JSON file in the data directory, newest first and bounded, so the file stays
 * readable and the API response stays small.
 */

const HISTORY_VERSION = 1;

/** How many switches are kept. Ten is enough to see a pattern, short enough
 * that the file is still something a person can read. */
export const REORG_HISTORY_LIMIT = 10;

export function reorgHistoryFile(chainFile) {
  return path.join(path.dirname(chainFile), 'switches.json');
}

function isEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    Number.isInteger(entry.forkHeight) &&
    Number.isInteger(entry.height) &&
    typeof entry.tip === 'string' &&
    entry.lost !== null &&
    typeof entry.lost === 'object' &&
    Number.isInteger(entry.lost.height) &&
    typeof entry.lost.hash === 'string'
  );
}

/**
 * Read the history, newest first. A missing, damaged or foreign file reads as
 * "no switches yet" rather than stopping a node from starting: this is
 * diagnostic detail, not consensus state.
 */
export function loadReorgHistory({ file, network, limit = REORG_HISTORY_LIMIT }) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== HISTORY_VERSION || data.network !== network) {
      return [];
    }
    const entries = Array.isArray(data.switches) ? data.switches : [];
    return entries.filter(isEntry).slice(0, limit);
  } catch {
    return [];
  }
}

function writeHistory({ file, network, entries }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: HISTORY_VERSION,
    network,
    switches: entries,
  };
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
  fs.renameSync(temporary, file);
}

/**
 * Record a switch and return the new history. Older entries are dropped once
 * the limit is reached, so the file never grows without bound.
 */
export function appendReorg({
  file,
  network,
  entry,
  limit = REORG_HISTORY_LIMIT,
}) {
  if (!isEntry(entry)) {
    throw new Error('a chain switch entry needs at, forkHeight, height, tip and lost');
  }
  const next = [entry, ...loadReorgHistory({ file, network, limit })].slice(
    0,
    Math.max(1, limit),
  );
  writeHistory({ file, network, entries: next });
  return next;
}
