import {
  bitsToTarget,
  blockWork,
  headerHash,
  meetsTarget,
  merkleRoot,
  targetToBits,
} from './block.js';
import {
  createCoinbase,
  isCoinbase,
  txSize,
  txid,
  validateTransaction,
} from './transaction.js';
import { addressFromHash, decodeAddress } from './keys.js';
import { MAX_MONEY } from './params.js';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const GENESIS_CACHE = new Map();

/** Block subsidy at a height: 50 DBL, halved every 210,000 blocks. */
export function subsidyAt(params, height) {
  const halvings = BigInt(height) / BigInt(params.halvingInterval);
  if (halvings >= 64n) {
    return 0n;
  }
  return params.initialSubsidy >> halvings;
}

/** The one hard-coded block every Doubloom node starts from. */
export function genesisBlock(params) {
  if (GENESIS_CACHE.has(params.name)) {
    return JSON.parse(GENESIS_CACHE.get(params.name));
  }

  const burnAddress = addressFromHash(Buffer.alloc(20), params.addressVersion);
  const coinbase = createCoinbase({
    height: 0,
    value: subsidyAt(params, 0),
    address: burnAddress,
    message: params.genesisMessage,
  });

  const block = {
    header: {
      version: 1,
      prevHash: '00'.repeat(32),
      merkleRoot: merkleRoot([txid(coinbase)]),
      time: params.genesisTime,
      bits: params.genesisBits,
      nonce: 0,
    },
    transactions: [coinbase],
  };

  // Genesis nonces are found deterministically so every node agrees.
  let nonce = 0;
  const target = bitsToTarget(block.header.bits);
  for (;;) {
    block.header.nonce = nonce;
    if (BigInt(`0x${headerHash(block.header)}`) <= target) break;
    nonce = (nonce + 1) >>> 0;
  }

  GENESIS_CACHE.set(params.name, JSON.stringify(block));
  return block;
}

export function cumulativeWork(blocks) {
  return blocks.reduce((total, block) => total + blockWork(block.header.bits), 0n);
}

/**
 * Circulating supply at `height`: the total subsidy of blocks 1..height. The
 * genesis subsidy is sent to a burn address and can never be spent, so it is
 * not counted (Bitcoin does the same).
 *
 * The subsidy is constant within a halving epoch, so this sums per epoch rather
 * than per block: a chain of a million blocks costs a few multiplications
 * instead of a million additions. `/api/info` used to pay that walk on every
 * request.
 */
export function supplyAtHeight(params, height) {
  if (!Number.isInteger(height) || height < 1) {
    return 0n;
  }
  const interval = params.halvingInterval;
  let supply = 0n;
  let start = 1;
  while (start <= height) {
    const subsidy = subsidyAt(params, start);
    if (subsidy === 0n) {
      break;
    }
    // Epochs are [e·interval, (e+1)·interval − 1]; height 0 is in the first one
    // but is excluded here, so the first term starts at 1.
    const end = Math.min(
      height,
      (Math.floor(start / interval) + 1) * interval - 1,
    );
    supply += subsidy * BigInt(end - start + 1);
    start = end + 1;
  }
  return supply;
}

/**
 * Read a block by absolute height.
 *
 * Callers usually hold a plain array, but a fork is replayed as several ranges
 * joined on the fly, which offers `blockAt` instead. Going through this keeps
 * the validators unaware of which they were given.
 */
function blockAt(chain, height) {
  return typeof chain.blockAt === 'function' ? chain.blockAt(height) : chain[height];
}

/** Median timestamp of the 11 blocks before `height` (Bitcoin's MTP rule). */
export function medianTimePast(blocks, height) {
  const start = Math.max(0, height - 11);
  const times = [];
  for (let index = start; index < height; index += 1) {
    times.push(blockAt(blocks, index).header.time);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/** Difficulty target the block at `height` must use. */
export function expectedBits(blocks, height, params) {
  if (height === 0) {
    return params.genesisBits;
  }
  if (height < params.retargetInterval || height % params.retargetInterval !== 0) {
    return blockAt(blocks, height - 1).header.bits;
  }

  const first = blockAt(blocks, height - params.retargetInterval);
  const last = blockAt(blocks, height - 1);
  const expectedTimespan = params.retargetInterval * params.targetBlockTime;
  const actualTimespan = Math.max(last.header.time - first.header.time, 1);
  const clamped = Math.min(
    Math.max(actualTimespan, Math.floor(expectedTimespan / 4)),
    expectedTimespan * 4,
  );

  const powLimit = bitsToTarget(params.powLimitBits);
  let target =
    (bitsToTarget(last.header.bits) * BigInt(clamped)) /
    BigInt(expectedTimespan);
  if (target > powLimit) {
    target = powLimit;
  }
  if (target < 1n) {
    target = 1n;
  }
  return targetToBits(target);
}

function checkCoinbase(coinbase, height, params) {
  if (!isCoinbase(coinbase)) {
    throw new ValidationError('first transaction must be a coinbase');
  }
  if (coinbase.inputs[0].height !== height) {
    throw new ValidationError('coinbase does not commit to the block height');
  }

  let total = 0n;
  for (const output of coinbase.outputs) {
    if (typeof output.value !== 'string' || !/^\d+$/.test(output.value)) {
      throw new ValidationError('coinbase has an invalid output value');
    }
    const value = BigInt(output.value);
    if (value <= 0n || value > MAX_MONEY) {
      throw new ValidationError('coinbase output value is out of range');
    }
    decodeAddress(output.address, params.addressVersion);
    total += value;
  }
  return total;
}

/**
 * Validate blocks[height] against the chain prefix blocks[0..height-1]
 * and the UTXO set produced by that prefix.
 */
export function validateBlockAt(blocks, height, utxos, params, txIndex = new Map()) {
  const block = blockAt(blocks, height);
  const previous = blockAt(blocks, height - 1);
  if (!block || !previous) {
    throw new ValidationError('block is not connected to the chain');
  }

  const header = block.header;
  if (!header || typeof header !== 'object') {
    throw new ValidationError('block has no header');
  }
  if (header.version !== 1) {
    throw new ValidationError('unsupported block version');
  }
  if (header.prevHash !== headerHash(previous.header)) {
    throw new ValidationError('previous block hash mismatch');
  }
  if (header.bits !== expectedBits(blocks, height, params)) {
    throw new ValidationError('incorrect difficulty target');
  }
  if (!meetsTarget(header)) {
    throw new ValidationError('proof of work does not meet target');
  }
  if (!Array.isArray(block.transactions) || block.transactions.length === 0) {
    throw new ValidationError('block has no transactions');
  }
  if (header.merkleRoot !== merkleRoot(block.transactions.map(txid))) {
    throw new ValidationError('merkle root mismatch');
  }
  if (!Number.isInteger(header.time) || header.time <= 0) {
    throw new ValidationError('invalid block timestamp');
  }
  if (header.time > Math.floor(Date.now() / 1000) + 7200) {
    throw new ValidationError('block timestamp is too far in the future');
  }
  if (header.time <= medianTimePast(blocks, height)) {
    throw new ValidationError('block timestamp is not after the median time past');
  }
  if (Buffer.byteLength(JSON.stringify(block)) > params.maxBlockBytes) {
    throw new ValidationError('block is larger than the maximum block size');
  }

  const coinbaseValue = checkCoinbase(block.transactions[0], height, params);

  // Outputs created earlier in this block are spendable by later transactions
  // in the same block, exactly as on Bitcoin.
  const created = new Map();
  const lookup = (transactionId, vout) =>
    created.get(`${transactionId}:${vout}`) ??
    utxos.get(`${transactionId}:${vout}`) ??
    null;

  const spent = new Set();
  const seenIds = new Set();
  let fees = 0n;
  for (const transaction of block.transactions.slice(1)) {
    if (isCoinbase(transaction)) {
      throw new ValidationError('block contains more than one coinbase');
    }
    const id = txid(transaction);
    if (txIndex.has(id) || seenIds.has(id)) {
      throw new ValidationError(`transaction ${id} is already in the chain`);
    }
    seenIds.add(id);

    const result = validateTransaction(transaction, lookup, {
      params,
      height,
      spent,
    });
    fees += result.fee;

    transaction.outputs.forEach((output, vout) => {
      created.set(`${id}:${vout}`, {
        txid: id,
        vout,
        value: BigInt(output.value),
        address: output.address,
        height,
        coinbase: false,
      });
    });
  }

  const maximum = subsidyAt(params, height) + fees;
  if (coinbaseValue > maximum) {
    throw new ValidationError('coinbase pays more than the subsidy plus fees');
  }

  return { fees, coinbaseValue };
}

/** Apply a block that has already been validated. */
export function applyBlockAt(blocks, height, utxos, txIndex) {
  const block = blockAt(blocks, height);

  for (const transaction of block.transactions.slice(1)) {
    for (const input of transaction.inputs) {
      utxos.delete(`${input.prevTxid}:${input.vout}`);
    }
  }

  for (const transaction of block.transactions) {
    const id = txid(transaction);
    const coinbase = isCoinbase(transaction);
    transaction.outputs.forEach((output, vout) => {
      utxos.set(`${id}:${vout}`, {
        txid: id,
        vout,
        value: BigInt(output.value),
        address: output.address,
        height,
        coinbase,
      });
    });
    txIndex.set(id, height);
  }
}

/**
 * A chain joined from consecutive ranges and indexed by absolute height.
 *
 * Adopting a fork replays our prefix followed by the peer's suffix. Building
 * that as one array would copy every block we already hold just to validate it,
 * so the ranges are read in place instead: the only extra memory a reorg needs
 * is the suffix it was handed.
 */
function rangedChain(ranges) {
  const parts = [];
  let length = 0;

  for (const range of ranges) {
    const blocks = range.blocks;
    const start = Number.isInteger(range.start) ? range.start : 0;
    const end = Number.isInteger(range.end) ? range.end : blocks.length;
    const size = end - start;
    if (size > 0) {
      parts.push({ blocks, start, size, offset: length });
      length += size;
    }
  }

  return {
    length,
    blockAt(height) {
      if (!Number.isInteger(height) || height < 0 || height >= length) {
        return undefined;
      }
      // A fork is two ranges, so a short scan beats any lookup structure.
      for (const part of parts) {
        if (height < part.offset + part.size) {
          return part.blocks[part.start + (height - part.offset)];
        }
      }
      return undefined;
    },
  };
}

/**
 * Validate and replay a chain given as consecutive ranges, returning the UTXO
 * set and transaction index. Nothing is joined into a new array: each range is
 * walked where it already sits.
 */
export function replayRanges(params, ranges, onBlock) {
  const chain = rangedChain(ranges);
  if (chain.length === 0) {
    throw new ValidationError('chain is empty');
  }

  const genesis = genesisBlock(params);
  const first = chain.blockAt(0);
  if (first?.header?.prevHash !== '00'.repeat(32) ||
      headerHash(first.header) !== headerHash(genesis.header)) {
    throw new ValidationError('genesis block does not match this network');
  }

  const utxos = new Map();
  const txIndex = new Map();
  applyBlockAt(chain, 0, utxos, txIndex);
  // Optional per-block hook, for callers that have to show how much of a chain
  // they have got through (a backup verifying its own archive). It observes
  // only; nothing about validation depends on it.
  onBlock?.(1);

  for (let height = 1; height < chain.length; height += 1) {
    validateBlockAt(chain, height, utxos, params, txIndex);
    applyBlockAt(chain, height, utxos, txIndex);
    onBlock?.(height + 1);
  }

  return { utxos, txIndex };
}

/** Verify a whole chain from genesis and rebuild its UTXO set. */
export function replayChain(params, blocks, onBlock) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new ValidationError('chain is empty');
  }
  return replayRanges(params, [{ blocks }], onBlock);
}

export class Chain {
  constructor(params, blocks, onBlock) {
    this.params = params;
    this.blocks = blocks;
    this.mempool = new Map();
    // Cumulative work is read on every /api/info and on every peer comparison,
    // so it is maintained alongside `blocks` instead of re-summing the headers
    // each time. See `addBlock`, `adopt` and `applyExtension`, the only places
    // that change the chain.
    this.cachedWork = cumulativeWork(blocks);
    // Supply is a function of height alone and is read on every /api/info and
    // `doubloom info`, so it is kept beside the blocks too. The same three
    // places keep it honest: addBlock, adopt and applyExtension.
    this.cachedSupply = supplyAtHeight(params, blocks.length - 1);
    const { utxos, txIndex } = replayChain(params, blocks, onBlock);
    this.utxos = utxos;
    this.txIndex = txIndex;
  }

  static create(params) {
    return new Chain(params, [genesisBlock(params)]);
  }

  get height() {
    return this.blocks.length - 1;
  }

  get tip() {
    return this.blocks[this.blocks.length - 1];
  }

  get work() {
    return this.cachedWork;
  }

  get nextBits() {
    return expectedBits(this.blocks, this.blocks.length, this.params);
  }

  get medianTimePast() {
    return medianTimePast(this.blocks, this.blocks.length);
  }

  get circulatingSupply() {
    // The genesis subsidy is excluded, as above; the total is maintained with
    // the blocks rather than re-summed per request.
    return this.cachedSupply;
  }

  difficulty() {
    const target = bitsToTarget(this.tip.header.bits);
    const limit = bitsToTarget(this.params.powLimitBits);
    return Number((limit * 10_000n) / target) / 10_000;
  }

  lookupOutput(transactionId, vout) {
    const confirmed = this.utxos.get(`${transactionId}:${vout}`);
    if (confirmed) {
      return confirmed;
    }
    const pending = this.mempool.get(transactionId);
    if (pending && pending.outputs[vout] !== undefined) {
      const output = pending.outputs[vout];
      return {
        txid: transactionId,
        vout,
        value: BigInt(output.value),
        address: output.address,
        height: this.height + 1,
        coinbase: false,
      };
    }
    return null;
  }

  utxosFor(address) {
    const result = [];
    for (const utxo of this.utxos.values()) {
      if (utxo.address === address) {
        result.push(utxo);
      }
    }
    return result.sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  }

  balanceOf(address) {
    return this.utxosFor(address).reduce((total, utxo) => total + utxo.value, 0n);
  }

  feeOf(transaction) {
    let total = 0n;
    for (const input of transaction.inputs) {
      const previous = this.lookupOutput(input.prevTxid, input.vout);
      if (!previous) {
        return 0n;
      }
      total += previous.value;
    }
    const outputs = transaction.outputs.reduce(
      (sum, output) => sum + BigInt(output.value),
      0n,
    );
    return total - outputs;
  }

  addTransaction(transaction) {
    const id = txid(transaction);
    if (this.txIndex.has(id)) {
      throw new ValidationError('transaction is already in the chain');
    }
    if (this.mempool.has(id)) {
      throw new ValidationError('transaction is already in the mempool');
    }

    const spent = new Set();
    for (const pending of this.mempool.values()) {
      for (const input of pending.inputs) {
        spent.add(`${input.prevTxid}:${input.vout}`);
      }
    }

    const result = validateTransaction(
      transaction,
      (transactionId, vout) => this.lookupOutput(transactionId, vout),
      {
        params: this.params,
        height: this.height + 1,
        spent,
        checkFeeRate: true,
      },
    );

    this.mempool.set(id, transaction);
    return { txid: id, fee: result.fee, size: result.size };
  }

  /** Ordered mempool entries with fee, size and fee rate. */
  mempoolEntries() {
    return [...this.mempool.entries()]
      .map(([id, transaction]) => {
        const fee = this.feeOf(transaction);
        const size = txSize(transaction);
        return { id, transaction, fee, size, feeRate: Number(fee) / size };
      })
      .sort((a, b) => {
        const left = a.fee * BigInt(b.size);
        const right = b.fee * BigInt(a.size);
        if (left === right) {
          return a.id < b.id ? -1 : 1;
        }
        return left > right ? -1 : 1;
      });
  }

  /** Build the next block template, including the best-paying mempool txs. */
  buildBlock(minerAddress) {
    decodeAddress(minerAddress, this.params.addressVersion);

    const height = this.height + 1;
    const subsidy = subsidyAt(this.params, height);
    const entries = this.mempoolEntries();

    // Select highest fee rates first, but never include a transaction before
    // the mempool transaction that funds it (in-block chaining is allowed).
    const picked = [];
    const pickedIds = new Set();
    let fees = 0n;
    let size = 0;
    let progress = true;
    while (progress) {
      progress = false;
      for (const entry of entries) {
        if (pickedIds.has(entry.id)) {
          continue;
        }
        if (size + entry.size > this.params.maxBlockBytes - 4000) {
          continue;
        }
        const waitingOnParent = entry.transaction.inputs.some(
          (input) =>
            this.mempool.has(input.prevTxid) &&
            !pickedIds.has(input.prevTxid),
        );
        if (waitingOnParent) {
          continue;
        }
        picked.push(entry.transaction);
        pickedIds.add(entry.id);
        fees += entry.fee;
        size += entry.size;
        progress = true;
      }
    }

    const coinbase = createCoinbase({
      height,
      value: subsidy + fees,
      address: minerAddress,
      message: `Doubloom ${this.params.name} block ${height}`,
    });
    const transactions = [coinbase, ...picked];

    return {
      header: {
        version: 1,
        prevHash: headerHash(this.tip.header),
        merkleRoot: merkleRoot(transactions.map(txid)),
        time: Math.max(Math.floor(Date.now() / 1000), this.medianTimePast + 1),
        bits: this.nextBits,
        nonce: 0,
      },
      transactions,
    };
  }

  addBlock(block) {
    const height = this.blocks.length;
    this.blocks.push(block);
    try {
      validateBlockAt(this.blocks, height, this.utxos, this.params, this.txIndex);
    } catch (error) {
      this.blocks.pop();
      throw error;
    }

    // Only a block that validated above adds to the chain's work and supply.
    this.cachedWork += blockWork(block.header.bits);
    this.cachedSupply += subsidyAt(this.params, height);
    applyBlockAt(this.blocks, height, this.utxos, this.txIndex);
    this.pruneMempool();
    return { height, hash: headerHash(block.header) };
  }

  pruneMempool() {
    if (this.mempool.size === 0) {
      return;
    }
    const pending = [...this.mempool.values()];
    this.mempool.clear();
    for (const transaction of pending) {
      if (this.txIndex.has(txid(transaction))) {
        continue;
      }
      try {
        this.addTransaction(transaction);
      } catch {
        // Spent by the new block or otherwise no longer valid: drop it.
      }
    }
  }

  /**
   * Adopt a peer's chain if it has more cumulative proof-of-work.
   *
   * `blocks` is a whole chain, or only the blocks after our height `from` when
   * a sync pass already knows the shared point. Passing the suffix lets sync
   * hand over what it received without concatenating it to our own chain: there
   * is no merged array to build, no map of every hash we hold, and the work
   * comparison only sums the suffix and the branch it replaces.
   *
   * A peer that only extended our tip needs no replay: its first new block
   * names our tip as its parent, so the blocks above it are all there is to
   * validate and apply. A fork still rebuilds the UTXO set because every block
   * above the fork point changes — but it replays our prefix and the peer's
   * suffix as two ranges, then truncates and appends to the list it already
   * has. Neither path materialises a second chain.
   */
  adopt(blocks, { from = null } = {}) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new ValidationError('peer sent an empty chain');
    }

    const suffix = from === null ? this.sharedSuffix(blocks) : this.knownSuffix(blocks, from);
    if (suffix === null) {
      return {
        added: 0,
        reorg: false,
        height: this.height,
        fork: null,
        dropped: [],
      };
    }
    if (suffix.from === this.height) {
      return this.applyExtension(suffix.blocks);
    }

    const previousTipHeight = this.height;

    // Our total already covers the blocks being replaced, so the merged total
    // is our work minus that branch plus the peer's suffix. Summing only those
    // is what keeps a fork cheap on a long chain.
    const mergedWork =
      this.work - this.workAbove(suffix.from) + cumulativeWork(suffix.blocks);
    if (mergedWork <= this.work) {
      throw new ValidationError('peer chain has no more work than ours');
    }

    // Our prefix and the peer's suffix are replayed as two ranges, so the
    // joined chain is never built: a reorg costs the suffix it was handed, not
    // a second copy of every block we already had.
    const { utxos, txIndex } = replayRanges(this.params, [
      { blocks: this.blocks, end: suffix.from + 1 },
      { blocks: suffix.blocks },
    ]);

    // The blocks this adoption replaces, by hash. A caller that keeps its own
    // index of what the node knows can remove exactly these and add the ones
    // below, instead of rehashing a chain that is otherwise unchanged.
    const dropped = [];
    for (let index = suffix.from + 1; index < this.blocks.length; index += 1) {
      dropped.push(headerHash(this.blocks[index].header));
    }

    // Only once that has succeeded is our own list touched, and in place: drop
    // the branch being replaced and append the winner to the array we have.
    this.blocks.length = suffix.from + 1;
    for (const block of suffix.blocks) {
      this.blocks.push(block);
    }
    this.cachedWork = mergedWork;
    // Supply follows height, not work: the peer branch can be longer or
    // shorter than the one it replaces.
    this.cachedSupply = supplyAtHeight(this.params, this.blocks.length - 1);
    this.utxos = utxos;
    this.txIndex = txIndex;
    this.pruneMempool();

    return {
      added: suffix.blocks.length,
      reorg: suffix.from < previousTipHeight,
      height: this.height,
      // The last block the peer's branch shares with ours: where a reorg split.
      fork: suffix.from,
      // Hashes of the blocks that left the chain.
      dropped,
    };
  }

  /** Cumulative work of the blocks above `height`, which a fork replaces. */
  workAbove(height) {
    let work = 0n;
    for (let index = height + 1; index < this.blocks.length; index += 1) {
      work += blockWork(this.blocks[index].header.bits);
    }
    return work;
  }

  /**
   * Blocks after our tip when the peer sent a whole chain. Returns `null` when
   * the peer has nothing we lack, and the fork point it connects at.
   */
  sharedSuffix(remoteBlocks) {
    const tipHash = headerHash(this.tip.header);
    const extensionStart = this.blocks.length;
    if (
      remoteBlocks.length > extensionStart &&
      remoteBlocks[extensionStart]?.header?.prevHash === tipHash
    ) {
      return { from: this.height, blocks: remoteBlocks.slice(extensionStart) };
    }

    const ourHashes = new Map(
      this.blocks.map((block, height) => [headerHash(block.header), height]),
    );

    let forkHeight = 0;
    let index = 0;
    while (index < remoteBlocks.length) {
      const remoteHeight = ourHashes.get(headerHash(remoteBlocks[index].header));
      if (remoteHeight === undefined) {
        break;
      }
      forkHeight = remoteHeight;
      index += 1;
    }

    if (index === 0) {
      throw new ValidationError('peer chain does not connect to ours');
    }
    if (index === remoteBlocks.length) {
      return null;
    }
    return { from: forkHeight, blocks: remoteBlocks.slice(index) };
  }

  /**
   * Blocks after `from` when the peer already sent only its suffix. The link
   * back to our chain is checked here, so a stale or hostile `from` cannot
   * splice an unrelated branch onto our tip.
   */
  knownSuffix(remoteBlocks, from) {
    if (!Number.isInteger(from) || from < 0 || from >= this.blocks.length) {
      throw new ValidationError('peer chain does not connect to ours');
    }
    if (
      remoteBlocks[0]?.header?.prevHash !== headerHash(this.blocks[from].header)
    ) {
      throw new ValidationError('peer chain does not connect to ours');
    }
    return { from, blocks: remoteBlocks };
  }

  /**
   * Append blocks that connect to our tip, validating and applying each one.
   *
   * Every appended block adds proof-of-work, so the result is strictly heavier
   * than the chain we had and no cumulative-work comparison is needed. A block
   * that fails validation restores the previous chain instead of leaving a
   * half-applied one.
   */
  applyExtension(blocks) {
    const previousLength = this.blocks.length;
    try {
      for (const block of blocks) {
        this.addBlock(block);
      }
    } catch (error) {
      this.blocks.length = previousLength;
      // Blocks came back off the chain, so both cached totals are rebuilt.
      this.cachedWork = cumulativeWork(this.blocks);
      this.cachedSupply = supplyAtHeight(this.params, this.blocks.length - 1);
      const { utxos, txIndex } = replayChain(this.params, this.blocks);
      this.utxos = utxos;
      this.txIndex = txIndex;
      this.pruneMempool();
      throw error;
    }

    return {
      added: blocks.length,
      reorg: false,
      height: this.height,
      // A straight extension shares every block we had, so nothing was dropped.
      fork: previousLength - 1,
      dropped: [],
    };
  }

  validate() {
    const { utxos, txIndex } = replayChain(this.params, this.blocks);
    this.utxos = utxos;
    this.txIndex = txIndex;
    return true;
  }
}
