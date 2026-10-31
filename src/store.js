import fs from 'node:fs';
import path from 'node:path';
import { Chain } from './chain.js';

export function saveChain(chain, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: 1,
    network: chain.params.name,
    blocks: chain.blocks,
    mempool: [...chain.mempool.values()],
  };
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload));
  fs.renameSync(temporary, file);
}

export function loadChain(params, file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.network !== params.name) {
    throw new Error(`chain at ${file} belongs to the ${payload.network} network`);
  }
  const chain = new Chain(params, payload.blocks);
  for (const transaction of payload.mempool ?? []) {
    try {
      chain.addTransaction(transaction);
    } catch {
      // The mempool entry expired while the node was offline.
    }
  }
  return chain;
}
