import { hash160, sha256d } from './hash.js';
import { MAX_MONEY } from './params.js';
import { decodeAddress, signDigest, verifyDigest } from './keys.js';

export const SIGHASH_ALL = 1;
const ZERO_TXID = '00'.repeat(32);
const NULL_VOUT = 0xffffffff;

/**
 * Doubloom serializes transactions as canonical JSON (fixed field order)
 * instead of Bitcoin's custom byte layout. Hashing, signing and the UTXO
 * rules are otherwise the same.
 */
export function canonicalTransaction(tx) {
  return {
    version: tx.version,
    inputs: tx.inputs.map((input) => ({
      prevTxid: input.prevTxid,
      vout: input.vout,
      sequence: input.sequence,
      ...(input.coinbase !== undefined
        ? { height: input.height, coinbase: input.coinbase }
        : {}),
      scriptSig: {
        signature: input.scriptSig?.signature ?? '',
        pubkey: input.scriptSig?.pubkey ?? '',
      },
    })),
    outputs: tx.outputs.map((output) => ({
      value: String(output.value),
      address: output.address,
    })),
    locktime: tx.locktime,
  };
}

export function serializeTransaction(tx) {
  return JSON.stringify(canonicalTransaction(tx));
}

export function txSize(tx) {
  return Buffer.byteLength(serializeTransaction(tx));
}

/** Transaction id: SHA-256d of the full serialized transaction, hex encoded. */
export function txid(tx) {
  return sha256d(Buffer.from(serializeTransaction(tx))).toString('hex');
}

export function isCoinbase(tx) {
  return (
    Array.isArray(tx?.inputs) &&
    tx.inputs.length === 1 &&
    tx.inputs[0].prevTxid === ZERO_TXID &&
    tx.inputs[0].vout === NULL_VOUT
  );
}

export function createCoinbase({ height, value, address, message = '' }) {
  return {
    version: 1,
    inputs: [
      {
        prevTxid: ZERO_TXID,
        vout: NULL_VOUT,
        sequence: 0xffffffff,
        height,
        coinbase: Buffer.from(message, 'utf8').toString('hex'),
        scriptSig: { signature: '', pubkey: '' },
      },
    ],
    outputs: [{ value: String(value), address }],
    locktime: 0,
  };
}

/**
 * The digest an input signature commits to: the whole transaction plus the
 * outpoint and value being spent (prevents value malleability).
 */
export function signatureHash(tx, index, prevout) {
  const preimage = {
    sighashType: SIGHASH_ALL,
    version: tx.version,
    locktime: tx.locktime,
    prevout: {
      txid: prevout.txid,
      vout: prevout.vout,
      address: prevout.address,
      value: String(prevout.value),
    },
    inputs: tx.inputs.map((input) => ({
      prevTxid: input.prevTxid,
      vout: input.vout,
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map((output) => ({
      value: String(output.value),
      address: output.address,
    })),
  };
  return sha256d(Buffer.from(JSON.stringify(preimage)));
}

export function signInput(tx, index, key, prevout) {
  const digest = signatureHash(tx, index, prevout);
  tx.inputs[index].scriptSig = {
    signature: signDigest(digest, key.privateKey),
    pubkey: key.publicKey,
  };
}

function parseOutputValue(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error('output value must be an integer number of petals');
  }
  return BigInt(text);
}

/**
 * Validate a non-coinbase transaction against a UTXO lookup.
 *
 * lookup(txid, vout) must return { txid, vout, value, address, height, coinbase }
 * or null. `spent` is a set of "txid:vout" keys that are already claimed.
 * Returns { fee, size } on success and throws on failure.
 */
export function validateTransaction(tx, lookup, options) {
  const { params, height } = options;
  const spent = options.spent ?? new Set();
  const checkFeeRate = options.checkFeeRate ?? false;

  if (!tx || typeof tx !== 'object') {
    throw new Error('transaction must be an object');
  }
  if (tx.version !== 1) {
    throw new Error('unsupported transaction version');
  }
  if (!Number.isInteger(tx.locktime) || tx.locktime < 0 || tx.locktime > 0xffffffff) {
    throw new Error('invalid locktime');
  }
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) {
    throw new Error('transaction has no inputs');
  }
  if (tx.inputs.length > 1000 || !Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    throw new Error('transaction has invalid inputs or outputs');
  }
  if (tx.outputs.length > 1000) {
    throw new Error('too many outputs');
  }
  if (isCoinbase(tx)) {
    throw new Error('coinbase transaction cannot be relayed');
  }

  const size = txSize(tx);
  if (size > params.maxTxBytes) {
    throw new Error('transaction is too large');
  }

  let totalOut = 0n;
  for (const output of tx.outputs) {
    const value = parseOutputValue(output.value);
    if (value <= 0n) {
      throw new Error('output value must be positive');
    }
    if (value > MAX_MONEY) {
      throw new Error('output value exceeds the money supply');
    }
    totalOut += value;
    if (totalOut > MAX_MONEY) {
      throw new Error('outputs exceed the money supply');
    }
    decodeAddress(output.address, params.addressVersion);
  }

  const seen = new Set();
  let totalIn = 0n;

  tx.inputs.forEach((input, index) => {
    if (
      typeof input.prevTxid !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.prevTxid) ||
      !Number.isInteger(input.vout) ||
      input.vout < 0
    ) {
      throw new Error('invalid input outpoint');
    }

    const key = `${input.prevTxid}:${input.vout}`;
    if (seen.has(key)) {
      throw new Error('transaction spends the same output twice');
    }
    seen.add(key);

    if (spent.has(key)) {
      throw new Error(`output ${key} is already spent`);
    }

    const prevout = lookup(input.prevTxid, input.vout);
    if (!prevout) {
      throw new Error(`output ${key} does not exist or is already spent`);
    }
    if (prevout.coinbase && height - prevout.height < params.coinbaseMaturity) {
      throw new Error(
        `coinbase output ${key} is not mature (needs ${params.coinbaseMaturity} confirmations)`,
      );
    }

    const signature = input.scriptSig?.signature;
    const publicKey = input.scriptSig?.pubkey;
    if (!signature || !publicKey) {
      throw new Error(`input ${index} is not signed`);
    }

    let expectedHash;
    try {
      expectedHash = decodeAddress(prevout.address, params.addressVersion).hash;
    } catch (error) {
      throw new Error(`invalid previous output address: ${error.message}`);
    }

    let actualHash;
    try {
      actualHash = hash160(Buffer.from(publicKey, 'hex'));
    } catch {
      throw new Error(`input ${index} has an invalid public key`);
    }
    if (!actualHash.equals(expectedHash)) {
      throw new Error(`input ${index} public key does not match the spent address`);
    }

    const digest = signatureHash(tx, index, prevout);
    if (!verifyDigest(digest, signature, publicKey)) {
      throw new Error(`input ${index} has an invalid signature`);
    }

    totalIn += prevout.value;
  });

  const fee = totalIn - totalOut;
  if (fee < 0n) {
    throw new Error('outputs are worth more than the inputs');
  }
  if (checkFeeRate) {
    const minimum = BigInt(Math.ceil(params.minFeeRate * size));
    if (fee < minimum) {
      throw new Error(
        `fee ${fee} is below the minimum relay fee ${minimum} petals`,
      );
    }
  }

  for (const input of tx.inputs) {
    spent.add(`${input.prevTxid}:${input.vout}`);
  }

  return { fee, size };
}
