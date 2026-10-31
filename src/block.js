import { sha256d } from './hash.js';

export const BLOCK_VERSION = 1;

/** Binary block header hash: SHA-256d of the 80-byte header, hex encoded. */
export function headerHash(header) {
  const buffer = Buffer.alloc(80);
  buffer.writeUInt32LE(header.version >>> 0, 0);
  Buffer.from(header.prevHash, 'hex').copy(buffer, 4, 0, 32);
  Buffer.from(header.merkleRoot, 'hex').copy(buffer, 36, 0, 32);
  buffer.writeUInt32LE(header.time >>> 0, 68);
  buffer.writeUInt32LE(header.bits >>> 0, 72);
  buffer.writeUInt32LE(header.nonce >>> 0, 76);
  return sha256d(buffer).toString('hex');
}

/** Bitcoin-style merkle root over hex transaction ids (odd levels duplicate). */
export function merkleRoot(txids) {
  if (!Array.isArray(txids) || txids.length === 0) {
    throw new Error('a block needs at least one transaction');
  }

  let level = txids.map((id) => {
    const bytes = Buffer.from(id, 'hex');
    if (bytes.length !== 32) {
      throw new Error('transaction ids must be 32 bytes');
    }
    return bytes;
  });

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256d(Buffer.concat([left, right])));
    }
    level = next;
  }

  return level[0].toString('hex');
}

/** Expand Bitcoin's compact "bits" notation into a 256-bit target. */
export function bitsToTarget(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) {
    throw new Error('invalid compact difficulty target');
  }
  if (bits & 0x00800000) {
    throw new Error('negative difficulty target');
  }
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  if (mantissa === 0) {
    throw new Error('zero difficulty target');
  }

  let target = BigInt(mantissa);
  if (exponent <= 3) {
    target >>= BigInt(8 * (3 - exponent));
  } else {
    target *= 256n ** BigInt(exponent - 3);
  }

  if (target > (1n << 256n) - 1n) {
    throw new Error('difficulty target overflows 256 bits');
  }
  return target;
}

/** Compress a 256-bit target into Bitcoin's compact "bits" notation. */
export function targetToBits(target) {
  const value = BigInt(target);
  if (value <= 0n) {
    throw new Error('target must be positive');
  }

  let size = 0;
  for (let remaining = value; remaining > 0n; remaining >>= 8n) {
    size += 1;
  }

  let compact =
    size <= 3
      ? value << BigInt(8 * (3 - size))
      : value >> BigInt(8 * (size - 3));

  if (compact & 0x00800000n) {
    compact >>= 8n;
    size += 1;
  }
  compact |= BigInt(size) << 24n;

  if (compact > 0xffffffffn) {
    throw new Error('target is too large to encode');
  }
  return Number(compact);
}

/** Expected hashes needed to find a block, used for cumulative chain work. */
export function blockWork(bits) {
  return (1n << 256n) / (bitsToTarget(bits) + 1n);
}

export function meetsTarget(header) {
  const target = bitsToTarget(header.bits);
  const hash = BigInt(`0x${headerHash(header)}`);
  return hash > 0n && hash <= target;
}

/** Synchronous proof-of-work search. Returns the header, or null if capped. */
export function mineHeader(header, { maxIterations = Infinity } = {}) {
  const target = bitsToTarget(header.bits);
  let nonce = header.nonce >>> 0;
  let iterations = 0;

  while (iterations < maxIterations) {
    header.nonce = nonce;
    if (BigInt(`0x${headerHash(header)}`) <= target) {
      return header;
    }
    nonce = (nonce + 1) >>> 0;
    if (nonce === 0) {
      header.time += 1;
    }
    iterations += 1;
  }

  return null;
}

/** Cooperative proof-of-work search so a node can keep serving requests. */
export async function mineHeaderAsync(header, { signal, batchSize = 20000 } = {}) {
  const target = bitsToTarget(header.bits);
  let nonce = header.nonce >>> 0;

  while (true) {
    for (let i = 0; i < batchSize; i += 1) {
      header.nonce = nonce;
      if (BigInt(`0x${headerHash(header)}`) <= target) {
        return header;
      }
      nonce = (nonce + 1) >>> 0;
      if (nonce === 0) {
        header.time += 1;
      }
    }
    if (signal?.aborted) {
      return null;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
