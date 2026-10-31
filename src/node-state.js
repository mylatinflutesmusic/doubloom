import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a node records the addresses it is reachable at. The chain file knows
 * nothing about networking, and the announced address can only be decided once
 * the port is bound, so it is written next to the chain when the node starts.
 * `doubloom info` reads it back to report where peers are told to find node.
 */

const STATE_VERSION = 1;

export function nodeStateFile(chainFile) {
  return path.join(path.dirname(chainFile), 'node.json');
}

export function saveNodeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: STATE_VERSION,
    ...state,
  };
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2));
  fs.renameSync(temporary, file);
  return payload;
}

/** Read the persisted state, ignoring a missing, stale or foreign file. */
export function loadNodeState({ stateFile, network }) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (data?.version !== STATE_VERSION || data.network !== network) {
      return null;
    }
    if (typeof data.announce !== 'string' || typeof data.url !== 'string') {
      return null;
    }
    return {
      network: data.network,
      pid: Number.isInteger(data.pid) ? data.pid : null,
      url: data.url,
      announce: data.announce,
      port: Number.isInteger(data.port) ? data.port : null,
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    };
  } catch {
    return null;
  }
}
