import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { networkParams, MAX_MONEY, COIN } from '../src/params.js';
import {
  Chain,
  genesisBlock,
  replayChain,
  replayRanges,
  subsidyAt,
  cumulativeWork,
  supplyAtHeight,
} from '../src/chain.js';
import {
  headerHash,
  merkleRoot,
  mineHeader,
  meetsTarget,
  bitsToTarget,
} from '../src/block.js';
import {
  createCoinbase,
  isCoinbase,
  signInput,
  txid,
  validateTransaction,
} from '../src/transaction.js';
import { Wallet, backupArchiveTime } from '../src/wallet.js';
import { saveChain, loadChain } from '../src/store.js';
import { createNodeBackup, restoreNodeBackup } from '../src/backup.js';
import { createBackupWorker } from '../src/backup-thread.js';
import {
  startBackupSchedule,
  loadBackupStatus,
  backupStatusFile,
  backupRecoveryDelayMs,
  backupFileName,
  defaultMaxLagBlocks,
  listArchives,
  normalizeRetention,
  pruneBackups,
  retentionAssignments,
  selectRetained,
} from '../src/backup-scheduler.js';
import {
  addressFromPublicKey,
  decodeAddress,
  generateKeyPair,
  signDigest,
  verifyDigest,
} from '../src/keys.js';
import { hash160, sha256d } from '../src/hash.js';
import { loadNodeState, nodeStateFile } from '../src/node-state.js';
import {
  appendReorg,
  loadReorgHistory,
  reorgHistoryFile,
} from '../src/reorg-history.js';
import { formatAmount, parseAmount } from '../src/amount.js';
import { parseSeed, discoverSeedPeers } from '../src/peer-discovery.js';
import { steadyGaps } from '../bench/growth.js';
import { formatWork, WORK_FULL_DIGITS } from '../src/work-format.js';

const mainnet = networkParams('mainnet');
const devnet = networkParams('devnet');

function mineBlocks(chain, address, count) {
  const mined = [];
  for (let index = 0; index < count; index += 1) {
    const block = chain.buildBlock(address);
    mineHeader(block.header);
    chain.addBlock(block);
    mined.push(headerHash(block.header));
  }
  return mined;
}

function readNodeArchive(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

function writeNodeArchive(file, value) {
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value))));
}

/**
 * Grow a chain far enough that a backup is slow enough to interrupt. Mining by
 * wall clock would make difficulty climb after every retarget; the benchmark's
 * gap pattern holds it at the genesis floor, which is what makes a few thousand
 * blocks affordable here.
 */
function mineSteadyBlocks(chain, address, count) {
  const gaps = steadyGaps(chain.params);
  let nextTime = chain.params.genesisTime;
  for (let index = 0; index < count; index += 1) {
    const block = chain.buildBlock(address);
    nextTime += gaps[chain.height % gaps.length];
    block.header.time = nextTime;
    mineHeader(block.header);
    chain.addBlock(block);
  }
}

/**
 * A node whose chain is long enough that a backup takes seconds rather than
 * milliseconds, which is what makes stopping one observable at all.
 */
function stoppableNode(passphrase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-cancel-'));
  const chainFile = path.join(dir, 'data', devnet.name, 'chain.json');
  const walletFile = path.join(dir, 'data', devnet.name, 'wallet.json');
  const wallet = Wallet.create(walletFile, devnet);
  const chain = Chain.create(devnet);
  mineSteadyBlocks(chain, wallet.defaultKey().address, 2_500);
  wallet.encrypt(passphrase);
  saveChain(chain, chainFile);
  return { dir, chainFile, walletFile, chain, wallet };
}

/** A non-loopback IPv4 address of this machine, or null when it has none. */
function externalIPv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function fundedChain(blockCount = 101) {
  const chain = Chain.create(devnet);
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const recipient = wallet.newKey('recipient');
  mineBlocks(chain, miner.address, blockCount);
  return { chain, wallet, miner, recipient };
}

test('hash160 and address generation', () => {
  assert.equal(
    hash160(Buffer.alloc(0)).toString('hex'),
    'b472a266d0bd89c13706a4132ccfb16f7c3b9fcb',
  );

  const { privateKey, publicKey } = generateKeyPair();
  const address = addressFromPublicKey(publicKey, mainnet.addressVersion);
  assert.match(address, /^D/);
  const decoded = decodeAddress(address, mainnet.addressVersion);
  assert.equal(decoded.hash.toString('hex'), hash160(Buffer.from(publicKey, 'hex')).toString('hex'));
  assert.throws(() => decodeAddress(address, devnet.addressVersion), /different network/);

  const digest = sha256d(Buffer.from('doubloom'));
  const signature = signDigest(digest, privateKey);
  assert.ok(verifyDigest(digest, signature, publicKey));
  assert.ok(!verifyDigest(sha256d(Buffer.from('doubloom!')), signature, publicKey));
});

test('genesis block is deterministic and meets proof of work', () => {
  const first = genesisBlock(mainnet);
  const second = genesisBlock(mainnet);
  assert.equal(headerHash(first.header), headerHash(second.header));
  assert.ok(meetsTarget(first.header));
  assert.equal(first.header.prevHash, '00'.repeat(32));
  assert.equal(first.transactions.length, 1);
  assert.ok(isCoinbase(first.transactions[0]));
  assert.equal(headerHash(genesisBlock(devnet).header) === headerHash(first.header), false);
});

test('subsidy schedule matches Bitcoin and never exceeds the cap', () => {
  assert.equal(subsidyAt(mainnet, 0), 50n * COIN);
  assert.equal(subsidyAt(mainnet, 209_999), 50n * COIN);
  assert.equal(subsidyAt(mainnet, 210_000), 25n * COIN);
  assert.equal(subsidyAt(mainnet, 420_000), 12n * COIN + COIN / 2n);
  assert.equal(subsidyAt(mainnet, 210_000 * 64), 0n);

  let total = 0n;
  for (let height = 0; height < 210_000 * 64; height += 1) {
    total += subsidyAt(mainnet, height);
  }
  // Integer halving truncation leaves the minted total just under the cap,
  // exactly as it does on Bitcoin (20,999,999.9769 BTC).
  assert.ok(total <= MAX_MONEY);
  assert.ok(MAX_MONEY - total < COIN);
  assert.equal(MAX_MONEY, 21_000_000n * COIN);
});

test('amount parsing and formatting', () => {
  assert.equal(parseAmount('1.5'), 150_000_000n);
  assert.equal(parseAmount('21'), 2_100_000_000n);
  assert.equal(formatAmount(150_000_000n), '1.5');
  assert.equal(formatAmount(1n), '0.00000001');
  assert.throws(() => parseAmount('1.123456789'), /invalid amount/);
  assert.throws(() => parseAmount('-2'), /invalid amount/);
});

test('a payment moves coins, pays a fee and confirms in a block', () => {
  const { chain, wallet, miner, recipient } = fundedChain();
  const startBalance = chain.balanceOf(miner.address);
  assert.equal(startBalance, 101n * 50n * COIN);

  const amount = 10n * COIN;
  const payment = wallet.buildTransaction(chain, {
    to: recipient.address,
    amount,
    feeRate: 1,
  });

  assert.equal(payment.transaction.outputs[0].value, String(amount));
  assert.ok(payment.fee > 0n);
  assert.equal(
    payment.transaction.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n) +
      payment.fee,
    payment.total,
  );

  chain.addTransaction(payment.transaction);
  assert.equal(chain.mempool.size, 1);
  assert.throws(
    () => chain.addTransaction(payment.transaction),
    /already in the mempool/,
  );

  const block = chain.buildBlock(miner.address);
  assert.equal(block.transactions.length, 2);
  mineHeader(block.header);
  chain.addBlock(block);

  assert.equal(chain.mempool.size, 0);
  assert.equal(chain.balanceOf(recipient.address), amount);
  // The fee returns to the miner inside the coinbase, so it cancels out.
  assert.equal(
    chain.balanceOf(miner.address),
    startBalance - amount + 50n * COIN,
  );

  // The recipient can now spend the payment.
  const refund = wallet.buildTransaction(chain, {
    from: recipient.address,
    to: miner.address,
    amount: 5n * COIN,
    feeRate: 1,
  });
  chain.addTransaction(refund.transaction);
  assert.equal(chain.mempool.size, 1);

  chain.validate();
});

test('an address cannot spend the same output twice', () => {
  const { chain, wallet, miner, recipient } = fundedChain();
  const first = wallet.buildTransaction(chain, {
    to: recipient.address,
    amount: 1n * COIN,
  });
  chain.addTransaction(first.transaction);

  const second = wallet.buildTransaction(chain, {
    to: recipient.address,
    amount: 1n * COIN,
  });
  assert.throws(() => chain.addTransaction(second.transaction), /already spent/);
});

test('coinbase outputs are not spendable before maturity', () => {
  const chain = Chain.create(devnet);
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const recipient = wallet.newKey('recipient');
  mineBlocks(chain, miner.address, 1);

  const utxo = chain.utxosFor(miner.address)[0];
  assert.equal(utxo.height, 1);
  assert.equal(utxo.coinbase, true);

  const transaction = {
    version: 1,
    inputs: [
      {
        prevTxid: utxo.txid,
        vout: utxo.vout,
        sequence: 0xffffffff,
        scriptSig: { signature: '', pubkey: '' },
      },
    ],
    outputs: [{ value: String(1n * COIN), address: recipient.address }],
    locktime: 0,
  };
  signInput(transaction, 0, miner, utxo);

  assert.throws(
    () => chain.addTransaction(transaction),
    /not mature/,
  );
});

test('invalid signatures, double spends and low fees are rejected', () => {
  const { chain, wallet, miner, recipient } = fundedChain();
  const payment = wallet.buildTransaction(chain, {
    to: recipient.address,
    amount: 1n * COIN,
  });

  const tampered = JSON.parse(JSON.stringify(payment.transaction));
  tampered.outputs[0].value = String(2n * COIN);
  assert.throws(() => chain.addTransaction(tampered), /invalid signature/);

  const negative = JSON.parse(JSON.stringify(payment.transaction));
  negative.outputs[0].value = String(0n);
  assert.throws(() => chain.addTransaction(negative), /positive/);

  const utxo = chain.utxosFor(miner.address)[0];
  const zeroFee = {
    version: 1,
    inputs: [
      {
        prevTxid: utxo.txid,
        vout: utxo.vout,
        sequence: 0xffffffff,
        scriptSig: { signature: '', pubkey: '' },
      },
    ],
    outputs: [{ value: String(utxo.value), address: recipient.address }],
    locktime: 0,
  };
  signInput(zeroFee, 0, miner, utxo);
  assert.throws(() => chain.addTransaction(zeroFee), /below the minimum relay fee/);

  const lookup = (id, vout) =>
    chain.utxos.get(`${id}:${vout}`) ?? null;
  const spent = new Set([`${utxo.txid}:${utxo.vout}`]);
  assert.throws(
    () =>
      validateTransaction(payment.transaction, lookup, {
        params: devnet,
        height: chain.height + 1,
        spent,
      }),
    /already spent/,
  );
});

test('blocks with bad proof of work, merkle roots or coinbase values are rejected', () => {
  const { chain, miner } = fundedChain(2);

  // Bad proof of work.
  const badPow = chain.buildBlock(miner.address);
  mineHeader(badPow.header);
  while (meetsTarget(badPow.header)) {
    badPow.header.nonce = (badPow.header.nonce + 1) >>> 0;
  }
  assert.throws(() => chain.addBlock(badPow), /proof of work/);

  // Bad merkle root (re-mined so only the merkle root is wrong).
  const badMerkle = chain.buildBlock(miner.address);
  badMerkle.header.merkleRoot = '11'.repeat(32);
  badMerkle.header.nonce = 0;
  mineHeader(badMerkle.header);
  assert.throws(() => chain.addBlock(badMerkle), /merkle root/);

  // Coinbase paying itself too much.
  const greedy = chain.buildBlock(miner.address);
  greedy.transactions[0].outputs[0].value = String(51n * COIN);
  greedy.header.merkleRoot = merkleRoot(greedy.transactions.map(txid));
  greedy.header.nonce = 0;
  mineHeader(greedy.header);
  assert.throws(() => chain.addBlock(greedy), /coinbase pays more/);

  // Wrong height in the coinbase.
  const wrongHeight = chain.buildBlock(miner.address);
  wrongHeight.transactions[0].inputs[0].height += 1;
  wrongHeight.header.merkleRoot = merkleRoot(wrongHeight.transactions.map(txid));
  wrongHeight.header.nonce = 0;
  mineHeader(wrongHeight.header);
  assert.throws(() => chain.addBlock(wrongHeight), /height/);

  assert.equal(chain.height, 2);
});

test('a competing chain with more work wins and rebuilds the UTXO set', () => {
  const chainA = Chain.create(devnet);
  const chainB = Chain.create(devnet);
  const chainC = Chain.create(devnet);
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('miner-a');
  const minerB = wallet.newKey('miner-b');

  mineBlocks(chainA, minerA.address, 2);
  mineBlocks(chainB, minerB.address, 4);

  assert.ok(cumulativeWork(chainB.blocks) > cumulativeWork(chainA.blocks));
  const result = chainA.adopt(chainB.blocks);
  assert.equal(result.reorg, true);
  assert.equal(chainA.height, 4);
  assert.equal(headerHash(chainA.tip.header), headerHash(chainB.tip.header));
  assert.equal(chainA.balanceOf(minerB.address), 4n * 50n * COIN);
  assert.equal(chainA.balanceOf(minerA.address), 0n);

  // A shorter chain is never adopted.
  mineBlocks(chainC, minerA.address, 3);
  assert.throws(() => chainA.adopt(chainC.blocks), /no more work/);
});

test('an equal-work fork is rejected and leaves the chain untouched', () => {
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('miner-a');
  const minerB = wallet.newKey('miner-b');
  const chainA = Chain.create(devnet);
  const chainB = Chain.create(devnet);
  mineBlocks(chainA, minerA.address, 4);
  mineBlocks(chainB, minerB.address, 4);

  // Same height on a constant-difficulty branch means exactly equal work.
  assert.equal(chainA.height, chainB.height);
  assert.equal(chainA.work, chainB.work);
  assert.notEqual(
    headerHash(chainA.tip.header),
    headerHash(chainB.tip.header),
    'the branches really differ',
  );

  const tip = headerHash(chainA.tip.header);
  const balance = chainA.balanceOf(minerA.address);

  // A tie never wins: neither a whole chain nor the suffix sync sends.
  assert.throws(
    () => chainA.adopt(chainB.blocks),
    /peer chain has no more work than ours/,
  );
  assert.throws(
    () => chainA.adopt(chainB.blocks.slice(1), { from: 0 }),
    /peer chain has no more work than ours/,
  );

  assert.equal(chainA.height, 4);
  assert.equal(headerHash(chainA.tip.header), tip);
  assert.equal(chainA.work, cumulativeWork(chainA.blocks));
  assert.equal(chainA.balanceOf(minerA.address), balance);
  assert.equal(
    chainA.balanceOf(minerB.address),
    0n,
    'the losing branch brought no coins along',
  );

  // One more block on the peer's branch does win, so the rejection is about
  // work rather than about refusing other branches on principle. The branches
  // only share genesis, so the suffix starts at height 1.
  mineBlocks(chainB, minerB.address, 1);
  const result = chainA.adopt(chainB.blocks.slice(1), { from: 0 });
  assert.equal(result.reorg, true);
  assert.equal(chainA.height, 5);
  assert.equal(chainA.work, chainB.work);
  assert.equal(chainA.work, cumulativeWork(chainA.blocks));
});

test('cumulative chain work is cached and tracks extensions and reorgs', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const chain = Chain.create(devnet);
  const genesisWork = chain.work;
  assert.equal(genesisWork, cumulativeWork(chain.blocks));

  mineBlocks(chain, miner.address, 4);
  assert.ok(chain.work > genesisWork);
  assert.equal(chain.work, cumulativeWork(chain.blocks));

  // Reading work must serve the cached total rather than walking the headers.
  const expected = chain.work;
  let headerReads = 0;
  chain.blocks = new Proxy(chain.blocks, {
    get(target, key, receiver) {
      headerReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(chain.work, expected);
  }
  assert.equal(headerReads, 0, 'work comes from the cache');

  // A heavier peer chain updates the total through the reorg path.
  const heavier = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(heavier, miner.address, 3);
  chain.adopt(heavier.blocks);
  assert.equal(chain.work, heavier.work);
  assert.equal(chain.work, cumulativeWork(chain.blocks));

  // A rejection cannot leave the cached work ahead of the actual chain.
  const beforeRejected = chain.work;
  const extension = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(extension, miner.address, 2);
  const next = extension.blocks[chain.height + 1];
  const corrupt = JSON.parse(JSON.stringify(extension.blocks[chain.height + 2]));
  corrupt.transactions[0].outputs[0].value = '0';
  assert.throws(() => chain.applyExtension([next, corrupt]), /merkle|coinbase|value/);
  assert.equal(chain.height, heavier.height, 'the chain was rolled back');
  assert.equal(chain.work, beforeRejected);
  assert.equal(chain.work, cumulativeWork(chain.blocks));

  // A straight extension grows the total block by block.
  chain.adopt(extension.blocks);
  assert.equal(chain.work, extension.work);
  assert.equal(chain.work, cumulativeWork(chain.blocks));
});

test('the benchmark holds difficulty at the genesis floor', async () => {
  const { steadyGaps } = await import('../bench/growth.js');

  for (const params of [mainnet, devnet]) {
    const gaps = steadyGaps(params);
    const expected = params.retargetInterval * params.targetBlockTime;

    // A retarget window spans one gap per block in it except the first, so the
    // pattern is exactly that long — otherwise the spans would not line up.
    assert.equal(gaps.length, params.retargetInterval - 1);
    assert.ok(
      gaps.every((gap) => Number.isInteger(gap) && gap > 0),
      'block times are whole seconds',
    );
    assert.equal(gaps.reduce((total, gap) => total + gap, 0), expected);

    // Retarget windows start at every multiple of the interval, so the pattern
    // has to work from any offset: every rotation must sum to the same span.
    for (let start = 0; start < gaps.length; start += 1) {
      let span = 0;
      for (let index = 0; index < gaps.length; index += 1) {
        span += gaps[(start + index) % gaps.length];
      }
      assert.equal(span, expected, `window starting at ${start}`);
    }
  }
});

test('supply at a height sums whole halving epochs', () => {
  // A tiny halving interval makes the epoch edges visible: heights 1-4 pay the
  // first subsidy, 5-9 half of it, 10+ a quarter.
  const tiny = { ...devnet, halvingInterval: 5, initialSubsidy: 100n };
  const bruteForce = (height) => {
    let total = 0n;
    for (let index = 1; index <= height; index += 1) {
      total += subsidyAt(tiny, index);
    }
    return total;
  };

  for (const height of [0, 1, 4, 5, 6, 9, 10, 12, 500]) {
    assert.equal(
      supplyAtHeight(tiny, height),
      bruteForce(height),
      `supply at ${height}`,
    );
  }

  // The epoch edges in full, so an off-by-one at a boundary is not hidden by
  // the comparison above sharing the same mistake.
  assert.equal(supplyAtHeight(tiny, 4), 400n);
  assert.equal(supplyAtHeight(tiny, 5), 450n);
  assert.equal(supplyAtHeight(tiny, 9), 650n);
  assert.equal(supplyAtHeight(tiny, 10), 675n);
  assert.equal(supplyAtHeight(tiny, 12), 725n);

  // Heights before the first spendable block hold nothing.
  assert.equal(supplyAtHeight(tiny, 0), 0n);
  assert.equal(supplyAtHeight(tiny, -5), 0n);
  assert.equal(supplyAtHeight(tiny, 1.5), 0n);
});

test('circulating supply is cached and tracks extensions and reorgs', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const chain = Chain.create(devnet);
  const bruteForce = (target) => {
    let total = 0n;
    for (let height = 1; height <= target.height; height += 1) {
      total += subsidyAt(devnet, height);
    }
    return total;
  };

  // The genesis subsidy is burned, so a fresh chain circulates nothing.
  assert.equal(chain.circulatingSupply, 0n);

  mineBlocks(chain, miner.address, 4);
  assert.equal(chain.circulatingSupply, subsidyAt(devnet, 1) * 4n);
  assert.equal(chain.circulatingSupply, bruteForce(chain));
  assert.equal(chain.circulatingSupply, supplyAtHeight(devnet, chain.height));

  // Reading supply must serve the cached total rather than walking the blocks.
  const expected = chain.circulatingSupply;
  const realBlocks = chain.blocks;
  let blockReads = 0;
  chain.blocks = new Proxy(realBlocks, {
    get(target, key, receiver) {
      blockReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(chain.circulatingSupply, expected);
  }
  assert.equal(blockReads, 0, 'supply comes from the cache');
  chain.blocks = realBlocks;

  // A peer branch of a different height replaces ours through the reorg path.
  const longer = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(longer, miner.address, 3);
  chain.adopt(longer.blocks);
  assert.equal(chain.circulatingSupply, longer.circulatingSupply);
  assert.equal(chain.circulatingSupply, bruteForce(chain));

  // A rejected extension cannot leave the cached supply ahead of the chain.
  const beforeRejected = chain.circulatingSupply;
  const extension = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(extension, miner.address, 2);
  const next = extension.blocks[chain.height + 1];
  const corrupt = JSON.parse(JSON.stringify(extension.blocks[chain.height + 2]));
  corrupt.transactions[0].outputs[0].value = '0';
  assert.throws(() => chain.applyExtension([next, corrupt]), /merkle|coinbase|value/);
  assert.equal(chain.height, longer.height, 'the chain was rolled back');
  assert.equal(chain.circulatingSupply, beforeRejected);
  assert.equal(chain.circulatingSupply, bruteForce(chain));

  // A straight extension grows the total block by block.
  chain.adopt(extension.blocks);
  assert.equal(chain.circulatingSupply, extension.circulatingSupply);
  assert.equal(chain.circulatingSupply, bruteForce(chain));

  // Rebuilding a chain from its blocks starts from the right total.
  const reloaded = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  assert.equal(reloaded.circulatingSupply, chain.circulatingSupply);
});

test('adopt takes a peer suffix instead of a merged chain copy', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 20);

  // A peer that simply extended our tip: the suffix is all it sends.
  const peer = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(peer, peerMiner.address, 4);
  const tipHeight = chain.height;
  const extended = chain.adopt(peer.blocks.slice(tipHeight + 1), { from: tipHeight });
  assert.equal(extended.added, 4);
  assert.equal(extended.reorg, false);
  assert.equal(chain.height, peer.height);
  assert.equal(chain.work, peer.work);

  // A peer on a fork: the suffix starts above the shared block, and the result
  // must match what adopting its whole chain produces.
  const branch = new Chain(
    devnet,
    JSON.parse(JSON.stringify(chain.blocks.slice(0, 16))),
  );
  mineBlocks(branch, peerMiner.address, 12);
  const forkHeight = 15;
  const control = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  const expected = control.adopt(JSON.parse(JSON.stringify(branch.blocks)));

  const forked = chain.adopt(branch.blocks.slice(forkHeight + 1), {
    from: forkHeight,
  });
  assert.deepEqual(forked, expected);
  assert.equal(forked.reorg, true);
  assert.equal(chain.height, branch.height);
  assert.equal(chain.work, branch.work);
  assert.equal(chain.work, cumulativeWork(chain.blocks));
  assert.equal(
    chain.balanceOf(peerMiner.address),
    control.balanceOf(peerMiner.address),
  );

  // A `from` that is out of range, or a suffix that does not descend from the
  // claimed block, is refused rather than spliced onto our tip.
  assert.throws(
    () => chain.adopt(branch.blocks.slice(-2), { from: 999 }),
    /does not connect/,
  );
  assert.throws(
    () => chain.adopt(chain.blocks.slice(-1), { from: 0 }),
    /does not connect/,
  );
  // A suffix that adds no work is rejected even though it connects.
  assert.throws(
    () =>
      chain.adopt(chain.blocks.slice(chain.height - 1), {
        from: chain.height - 2,
      }),
    /no more work/,
  );
  assert.equal(chain.height, branch.height, 'a rejected suffix changes nothing');
});

test('replay accepts a chain as consecutive ranges', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 12);
  const blocks = chain.blocks;

  const whole = replayChain(devnet, blocks);
  const split = replayRanges(devnet, [
    { blocks, end: 5 },
    { blocks, start: 5, end: 9 },
    { blocks, start: 9 },
  ]);

  // Walking the ranges must produce exactly the ledger a single array does.
  assert.deepEqual(
    [...split.utxos.keys()].sort(),
    [...whole.utxos.keys()].sort(),
  );
  assert.deepEqual(
    [...split.utxos.entries()].sort(),
    [...whole.utxos.entries()].sort(),
  );
  assert.deepEqual(
    [...split.txIndex.entries()].sort(),
    [...whole.txIndex.entries()].sort(),
  );

  // Empty and genesis-less chains are refused rather than replayed from the
  // wrong starting point.
  assert.throws(() => replayRanges(devnet, []), /chain is empty/);
  assert.throws(
    () => replayRanges(devnet, [{ blocks, start: 5 }]),
    /genesis block does not match/,
  );
});

test('adopting a fork keeps the block list it already has', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 10);

  // A heavier branch off our block 6: five blocks where we have four.
  const branch = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks.slice(0, 7))));
  mineBlocks(branch, peerMiner.address, 5);

  const list = chain.blocks;
  const replaced = chain.blocks
    .slice(7)
    .map((block) => headerHash(block.header));
  const adopted = chain.adopt(JSON.parse(JSON.stringify(branch.blocks)));

  // The blocks that lost are reported by hash, so a caller's own index can drop
  // them without rehashing the chain it kept.
  assert.deepEqual([...adopted.dropped].sort(), [...replaced].sort());

  // A reorg must not replace the array: the prefix is replayed where it sits
  // and the suffix is appended to the list we already hold.
  assert.equal(chain.blocks, list, 'the same array is kept, not a merged copy');
  assert.equal(adopted.reorg, true);
  assert.equal(adopted.fork, 6);
  assert.equal(chain.height, branch.height);
  assert.equal(list.length, branch.height + 1);
  assert.equal(chain.work, branch.work);

  // The ledger matches a chain built from the same blocks from scratch.
  const rebuilt = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  assert.equal(chain.utxos.size, rebuilt.utxos.size);
  assert.equal(chain.txIndex.size, rebuilt.txIndex.size);
  assert.equal(
    chain.balanceOf(peerMiner.address),
    rebuilt.balanceOf(peerMiner.address),
  );
  assert.equal(chain.circulatingSupply, rebuilt.circulatingSupply);

  // A branch of the same height carries the same work, whatever it pays to:
  // it is refused, and refusal leaves the list and its contents untouched.
  const otherMiner = wallet.newKey('other');
  const snapshot = chain.blocks.slice();
  const equalWork = new Chain(
    devnet,
    JSON.parse(JSON.stringify(chain.blocks.slice(0, 6))),
  );
  mineBlocks(equalWork, otherMiner.address, 6);
  assert.equal(equalWork.height, chain.height);
  assert.equal(equalWork.work, chain.work);
  assert.throws(
    () => chain.adopt(JSON.parse(JSON.stringify(equalWork.blocks))),
    /no more work/,
  );
  assert.equal(chain.blocks, list);
  assert.deepEqual(chain.blocks, snapshot);
});

test('a straight extension is applied without rebuilding the UTXO set', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 30);

  const peer = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(peer, peerMiner.address, 5);

  const utxos = chain.utxos;
  const txIndex = chain.txIndex;
  const result = chain.adopt(peer.blocks);

  assert.equal(result.added, 5);
  assert.equal(result.reorg, false);
  assert.equal(chain.height, 35);
  assert.equal(headerHash(chain.tip.header), headerHash(peer.tip.header));
  // Identical Map instances: the new blocks were applied in place rather than
  // replayed from genesis.
  assert.equal(chain.utxos, utxos);
  assert.equal(chain.txIndex, txIndex);
  assert.equal(chain.balanceOf(peerMiner.address), 5n * 50n * COIN);
  assert.equal(chain.balanceOf(miner.address), 30n * 50n * COIN);

  // The incrementally maintained state still matches a full replay.
  assert.equal(chain.validate(), true);
  assert.equal(chain.balanceOf(peerMiner.address), 5n * 50n * COIN);
});

test('a bad block in an extension leaves the chain unchanged', () => {
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 20);

  const peer = new Chain(devnet, JSON.parse(JSON.stringify(chain.blocks)));
  mineBlocks(peer, peerMiner.address, 3);

  const tipHash = headerHash(chain.tip.header);
  // Make the second appended block pay itself too much, then re-mine it so the
  // only thing wrong is the amount.
  const greedy = peer.blocks[22];
  greedy.transactions[0].outputs[0].value = String(51n * COIN);
  greedy.header.merkleRoot = merkleRoot(greedy.transactions.map(txid));
  greedy.header.nonce = 0;
  mineHeader(greedy.header);

  assert.throws(() => chain.adopt(peer.blocks), /coinbase pays more/);
  assert.equal(chain.height, 20, 'the valid prefix of the extension is rolled back');
  assert.equal(headerHash(chain.tip.header), tipHash);
  assert.equal(chain.balanceOf(peerMiner.address), 0n);
  assert.equal(chain.validate(), true);
});

test('an extension adopted during sync is treated as known', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-extension-sync-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');

  const chainA = Chain.create(devnet);
  mineBlocks(chainA, miner.address, 20);
  // The node adopts B's suffix, so remember where the two chains diverged
  // before A starts sharing (and mutating) chainA.
  const ancestorHash = headerHash(chainA.tip.header);
  // B shares A's history and simply mined further, so adopting it is an
  // extension rather than a fork.
  const chainB = new Chain(devnet, JSON.parse(JSON.stringify(chainA.blocks)));
  mineBlocks(chainB, peerMiner.address, 7);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
  });
  let nodeA = null;

  try {
    const deadline = Date.now() + 3000;
    while (!nodeB.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const bUrl = `http://127.0.0.1:${nodeB.server.address().port}`;

    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      peers: [bUrl],
    });
    const aDeadline = Date.now() + 3000;
    while (!nodeA.server.address() && Date.now() < aDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const aUrl = `http://127.0.0.1:${nodeA.server.address().port}`;

    const synced = Date.now() + 5000;
    let info = await (await fetch(`${aUrl}/api/info`)).json();
    while (info.height !== 27 && Date.now() < synced) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      info = await (await fetch(`${aUrl}/api/info`)).json();
    }
    assert.equal(info.height, 27, 'the extension was adopted');

    // The sync line reports the transfer size, and it matches the payload the
    // peer would send for the same locator.
    const syncLine = logs.find((line) => line.startsWith('synced 7 block(s),'));
    assert.ok(syncLine, 'the sync was logged as an extension, not a reorg');
    assert.match(
      syncLine,
      /^synced 7 block\(s\), [\d.]+ (B|KiB|MiB) from http:\/\/127\.0\.0\.1:\d+$/,
    );
    const payloadBody = await (
      await fetch(`${bUrl}/api/chain?locator=${ancestorHash}`)
    ).text();
    const payloadBytes = Buffer.byteLength(payloadBody);
    const sizeLabel =
      payloadBytes < 1024
        ? `${payloadBytes} B`
        : payloadBytes < 1024 * 1024
          ? `${(payloadBytes / 1024).toFixed(1)} KiB`
          : `${(payloadBytes / (1024 * 1024)).toFixed(1)} MiB`;
    assert.ok(
      syncLine.includes(`block(s), ${sizeLabel} from`),
      `the logged size ${syncLine} matches the ${sizeLabel} response`,
    );

    // The tip is now one of ours: pushing it back must be a duplicate, not a
    // reason to fetch the peer's chain again.
    const duplicate = await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chainB.tip),
    });
    assert.equal(duplicate.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      !logs.some((line) => line.includes('does not extend our tip')),
      'a known block does not trigger another fetch',
    );
  } finally {
    if (nodeA) {
      await nodeA.close();
    }
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reorg updates the node\'s known blocks without rescanning the chain', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-known-reorg-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');

  const chainA = Chain.create(devnet);
  mineBlocks(chainA, miner.address, 20);
  // B forks from A's block 15 and mines past it, so adopting B replaces the top
  // of A's chain instead of extending it.
  const chainB = new Chain(
    devnet,
    JSON.parse(JSON.stringify(chainA.blocks.slice(0, 16))),
  );
  mineBlocks(chainB, peerMiner.address, 12);

  // A block that loses the fork: pushed back after the reorg, the node can only
  // know it if its index still holds a hash the chain no longer contains.
  const abandoned = chainA.blocks[20];
  const abandonedHash = headerHash(abandoned.header);

  // Where node A stands before it syncs, captured now because startNode adopts
  // into the same Chain instance: this is the branch the log must name as lost.
  const lostTipHash = headerHash(chainA.tip.header);
  const lostWork = chainA.work;

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
  });
  let nodeA = null;

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };
  const push = (url, block) =>
    fetch(`${url}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(block),
    });

  try {
    const bUrl = await listening(nodeB);
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      peers: [bUrl],
    });
    const aUrl = await listening(nodeA);

    // The startup sync adopts B's heavier branch.
    const deadline = Date.now() + 8000;
    while (
      !logs.some((line) => line.includes('reorg at fork #')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      logs.some((line) => line.includes('reorg at fork #')),
      'the fork was adopted',
    );
    // The fork in this test is fixed, so the line can be pinned exactly: the
    // height that was replaced, both short hashes and the work difference.
    const reorgLine = logs.find((line) => line.includes('reorg at fork #'));
    assert.ok(
      reorgLine.includes(
        `reorg at fork #15: #20 ${lostTipHash.slice(0, 12)}… → #${chainB.height} ${headerHash(chainB.tip.header).slice(0, 12)}…, +${chainB.work - lostWork} work`,
      ),
      `the log names both tips and the work gained: ${reorgLine}`,
    );
    const info = await (await fetch(`${aUrl}/api/info`)).json();
    assert.equal(info.height, chainB.height);

    // The new tip is known: pushing it back is a duplicate, not a new branch.
    const seenFrom = logs.length;
    assert.equal((await push(aUrl, chainB.tip)).status, 400);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      !logs.slice(seenFrom).some((line) => line.includes('does not extend our tip')),
      'the adopted tip is known',
    );

    // The block that lost is not: it left the chain with the reorg, so it is no
    // longer something the node has seen. Pushing it asks for the peer's chain.
    const droppedFrom = logs.length;
    assert.equal((await push(aUrl, abandoned)).status, 400);
    const droppedDeadline = Date.now() + 3000;
    while (
      !logs
        .slice(droppedFrom)
        .some((line) => line.includes('does not extend our tip')) &&
      Date.now() < droppedDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      logs
        .slice(droppedFrom)
        .some(
          (line) =>
            line.includes('does not extend our tip') &&
            line.includes(abandonedHash),
        ),
      'a block dropped by the reorg is unknown again',
    );
  } finally {
    if (nodeA) {
      await nodeA.close();
    }
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the chain-switch history is bounded and survives a damaged file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-switches-'));
  const file = path.join(dir, 'switches.json');

  const entry = (index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    forkHeight: 100 + index,
    height: 200 + index,
    tip: `${index}`.repeat(64).slice(0, 64),
    peer: 'http://127.0.0.1:1',
    added: index,
    dropped: index + 1,
    lost: {
      height: 150 + index,
      hash: `f${index}`.repeat(64).slice(0, 64),
      work: '20',
      workAboveFork: '5',
    },
    gained: '7',
  });

  try {
    assert.deepEqual(
      loadReorgHistory({ file, network: devnet.name }),
      [],
      'no file means no history',
    );

    // Three entries, newest first, on disk after every append.
    for (const index of [1, 2, 3]) {
      const history = appendReorg({
        file,
        network: devnet.name,
        entry: entry(index),
        limit: 3,
      });
      assert.equal(history.length, index);
    }
    let history = loadReorgHistory({ file, network: devnet.name, limit: 3 });
    assert.deepEqual(
      history.map((item) => item.forkHeight),
      [103, 102, 101],
      'the newest switch is first',
    );

    // A fourth switch evicts the oldest: the file stays bounded.
    history = appendReorg({
      file,
      network: devnet.name,
      entry: entry(4),
      limit: 3,
    });
    assert.deepEqual(
      history.map((item) => item.forkHeight),
      [104, 103, 102],
    );
    assert.equal(
      JSON.parse(fs.readFileSync(file, 'utf8')).switches.length,
      3,
      'the file itself is bounded, not just the returned list',
    );
    assert.ok(
      !fs.existsSync(`${file}.tmp`),
      'the write is atomic: no temporary file is left behind',
    );

    // A file belonging to another network is ignored rather than mixed in.
    assert.deepEqual(
      loadReorgHistory({ file, network: mainnet.name }),
      [],
    );

    // Damage is tolerated: this is diagnostic detail, not consensus state.
    fs.writeFileSync(file, '{"version":1,"switches":[nu');
    assert.deepEqual(loadReorgHistory({ file, network: devnet.name }), []);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, network: devnet.name, switches: [{ at: 1 }] }),
    );
    assert.deepEqual(
      loadReorgHistory({ file, network: devnet.name }),
      [],
      'malformed entries are dropped instead of reported',
    );

    assert.throws(
      () => appendReorg({ file, network: devnet.name, entry: { at: 'now' } }),
      /chain switch entry needs/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reorg is recorded on disk with the branch it replaced', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-switch-log-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const peerMiner = wallet.newKey('peer');

  const chainA = Chain.create(devnet);
  mineBlocks(chainA, miner.address, 20);
  // B forks from A's block 15 and mines past it, so adopting B replaces the top
  // of A's chain instead of extending it.
  const chainB = new Chain(
    devnet,
    JSON.parse(JSON.stringify(chainA.blocks.slice(0, 16))),
  );
  mineBlocks(chainB, peerMiner.address, 12);

  // Everything the record has to agree with, captured before the node mutates
  // its chain in place.
  const lostTipHash = headerHash(chainA.tip.header);
  const lostHeight = chainA.height;
  const lostWork = chainA.work;
  const lostAboveFork = cumulativeWork(chainA.blocks.slice(16));
  const expectedGain = chainB.work - chainA.work;
  const chainFile = path.join(dir, 'a.json');

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
  });
  let nodeA = null;
  let restarted = null;

  try {
    const bUrl = await listening(nodeB);
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile,
      port: 0,
      peers: [bUrl],
    });
    const aUrl = await listening(nodeA);
    const deadline = Date.now() + 8000;
    while (
      !logs.some((line) => line.includes('reorg at fork #')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const file = reorgHistoryFile(chainFile);
    assert.ok(fs.existsSync(file), 'the switch is written beside the chain');
    const stored = loadReorgHistory({ file, network: devnet.name });
    assert.equal(stored.length, 1);
    const entry = stored[0];

    // The branch that lost, not just the one that arrived.
    assert.equal(entry.forkHeight, 15);
    assert.equal(entry.lost.height, lostHeight);
    assert.equal(entry.lost.hash, lostTipHash);
    assert.equal(BigInt(entry.lost.work), lostWork);
    assert.equal(
      BigInt(entry.lost.workAboveFork),
      lostAboveFork,
      'the work of the abandoned blocks is what was replaced',
    );
    assert.equal(entry.dropped, lostHeight - 15);
    assert.equal(entry.added, chainB.height - 15);
    assert.equal(entry.height, chainB.height);
    assert.equal(entry.tip, headerHash(chainB.tip.header));
    assert.equal(BigInt(entry.gained), expectedGain);
    assert.equal(entry.peer, bUrl);
    assert.ok(Number.isFinite(Date.parse(entry.at)));

    // The API reports the same record, and the notice reads from it.
    const info = await (await fetch(`${aUrl}/api/info`)).json();
    assert.deepEqual(info.reorgHistory, stored);
    assert.deepEqual(info.lastReorg, entry);

    // History is on disk, so a restart does not forget it.
    await nodeA.close();
    nodeA = null;
    restarted = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile,
      port: 0,
    });
    const restartedUrl = await listening(restarted);
    const after = await (await fetch(`${restartedUrl}/api/info`)).json();
    assert.deepEqual(after.reorgHistory, stored, 'a restart keeps the history');
    assert.deepEqual(after.lastReorg, entry);
  } finally {
    if (nodeA) {
      await nodeA.close();
    }
    if (restarted) {
      await restarted.close();
    }
    await nodeB.close();
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the explorer lists recent chain switches from the node', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /<ul class="switches" id="switches">/);
  assert.match(explorer, /id="switch-note"/);
  // Fed by the API's history, so the list reflects the node rather than what
  // this page happened to witness.
  assert.match(explorer, /renderSwitches\(info\.reorgHistory\)/);
  assert.match(explorer, /Array\.isArray\(history\) \? history\.slice\(0, 10\)/);
  // Each row names the branch that lost, its height and its hash.
  assert.match(explorer, /replaced #\$\{formatNumber\(lostHeight\)\}/);
  assert.match(explorer, /lostHash\.slice\(0, 10\)/);
  // And how much heavier the adopted branch was.
  assert.match(explorer, /\+\$\{formatWork\(gained\)\} work/);
});

test('difficulty retargets toward the target block time', () => {
  const chain = Chain.create(devnet);
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  // The first retarget can only ease difficulty (already at the pow limit),
  // so measure the second one, where fast blocks must make it harder.
  mineBlocks(chain, miner.address, devnet.retargetInterval * 2);

  const retargeted = chain.blocks[devnet.retargetInterval * 2];
  assert.notEqual(
    retargeted.header.bits,
    chain.blocks[devnet.retargetInterval].header.bits,
  );
  assert.ok(
    bitsToTarget(retargeted.header.bits) <
      bitsToTarget(chain.blocks[devnet.retargetInterval].header.bits),
  );

  chain.validate();
  const { utxos } = replayChain(devnet, chain.blocks);
  assert.equal(utxos.size, chain.blocks.length);
});

test('the genesis subsidy is unspendable and supply accounting is correct', () => {
  const chain = Chain.create(mainnet);
  assert.equal(chain.height, 0);
  assert.equal(chain.circulatingSupply, 0n);
  assert.equal(subsidyAt(mainnet, 0), 50n * COIN);

  const wallet = new Wallet('unused.json', mainnet);
  const key = wallet.newKey('buyer');
  const genesisAddress = chain.tip.transactions[0].outputs[0].address;
  assert.throws(
    () =>
      wallet.buildTransaction(chain, {
        from: key.address,
        to: genesisAddress,
        amount: 1n,
      }),
    /no spendable outputs/,
  );
});

test('a block can confirm a transaction that spends another transaction in the same block', () => {
  const { chain, wallet, miner, recipient } = fundedChain();
  const parent = wallet.buildTransaction(chain, {
    to: recipient.address,
    amount: 10n * COIN,
    feeRate: 1,
  });
  chain.addTransaction(parent.transaction);

  const parentId = txid(parent.transaction);
  const child = {
    version: 1,
    inputs: [
      {
        prevTxid: parentId,
        vout: 0,
        sequence: 0xffffffff,
        scriptSig: { signature: '', pubkey: '' },
      },
    ],
    outputs: [{ value: String(5n * COIN), address: miner.address }],
    locktime: 0,
  };
  signInput(child, 0, recipient, {
    txid: parentId,
    vout: 0,
    address: recipient.address,
    value: 10n * COIN,
  });
  chain.addTransaction(child);
  const childId = txid(child);

  // The child pays a much higher fee, so it sorts ahead of its parent and the
  // block builder must reorder the pair.
  const block = chain.buildBlock(miner.address);
  assert.equal(block.transactions.length, 3);
  assert.equal(txid(block.transactions[1]), parentId);
  assert.equal(txid(block.transactions[2]), childId);

  mineHeader(block.header);
  chain.addBlock(block);

  assert.equal(chain.txIndex.get(parentId), 102);
  assert.equal(chain.txIndex.get(childId), 102);
  assert.equal(chain.mempool.size, 0);
  chain.validate();
});

function temporaryNode(params = devnet, blockCount = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-node-'));
  const chainFile = path.join(dir, 'data', params.name, 'chain.json');
  const walletFile = path.join(dir, 'data', params.name, 'wallet.json');
  const wallet = Wallet.create(walletFile, params);
  const privateKey = wallet.defaultKey().privateKey;
  const chain = Chain.create(params);
  mineBlocks(chain, wallet.defaultKey().address, blockCount);
  saveChain(chain, chainFile);
  return { dir, chainFile, walletFile, chain, wallet, privateKey };
}

function temporaryWallet(params = devnet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-wallet-'));
  const file = path.join(dir, 'wallet.json');
  return { dir, file, wallet: Wallet.create(file, params) };
}

/** Give a wallet some spendable coins so signing can be tested. */
function fundWallet(chain, wallet, funder, miner) {
  const target = wallet.defaultKey();
  const funding = funder.buildTransaction(chain, {
    to: target.address,
    amount: 20n * COIN,
    feeRate: 1,
  });
  chain.addTransaction(funding.transaction);
  mineBlocks(chain, miner.address, 1);
  return target;
}

test('an encrypted wallet keeps keys secret and signs after unlocking', () => {
  const passphrase = 'correct horse battery staple';
  const { file, wallet } = temporaryWallet();
  const key = wallet.defaultKey();
  wallet.encrypt(passphrase);

  const raw = fs.readFileSync(file, 'utf8');
  const stored = JSON.parse(raw);
  assert.equal(stored.version, 2);
  assert.equal(stored.crypto.kdf, 'scrypt');
  assert.equal(stored.crypto.cipher, 'aes-256-gcm');
  assert.ok(!raw.includes(key.privateKey), 'no plaintext private key on disk');
  assert.ok(stored.keys[0].encryptedPrivateKey.ciphertext.length > 0);
  assert.equal(stored.keys[0].publicKey, key.publicKey);
  assert.equal(stored.keys[0].address, key.address);

  const locked = Wallet.load(file, devnet);
  assert.equal(locked.isEncrypted, true);
  assert.equal(locked.isUnlocked, false);
  assert.equal(locked.defaultKey().address, key.address);
  assert.throws(() => locked.privateKeyFor(key.address), /locked/);
  assert.throws(
    () => locked.unlock('this is the wrong passphrase'),
    /wrong passphrase or corrupted wallet file/,
  );
  assert.throws(() => locked.newKey('extra'), /locked/);

  const { chain, wallet: funder, miner } = fundedChain();
  fundWallet(chain, wallet, funder, miner);

  locked.unlock(passphrase);
  assert.equal(locked.isUnlocked, true);
  const payment = locked.buildTransaction(chain, {
    to: miner.address,
    amount: 5n * COIN,
    feeRate: 1,
  });
  chain.addTransaction(payment.transaction);
  assert.equal(txid(payment.transaction), payment.txid);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('a ciphertext moved to another address fails authentication', () => {
  const passphrase = 'another long passphrase';
  const { file, wallet } = temporaryWallet();
  wallet.newKey('second');
  wallet.encrypt(passphrase);

  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.keys[0].encryptedPrivateKey = stored.keys[1].encryptedPrivateKey;
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));

  assert.throws(
    () => Wallet.load(file, devnet).unlock(passphrase),
    /wrong passphrase or corrupted wallet file/,
  );
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('wallet unlock restores the plaintext format and wallet lock encrypts again', () => {
  const passphrase = 'temporary unlock passphrase';
  const { file, wallet } = temporaryWallet();
  wallet.encrypt(passphrase);

  assert.throws(
    () => Wallet.load(file, devnet).decryptToPlaintext('incorrect passphrase'),
    /wrong passphrase/,
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);

  assert.equal(wallet.decryptToPlaintext(passphrase), true);
  const plain = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(plain.version, 1);
  assert.equal(plain.crypto, undefined);
  assert.equal(typeof plain.keys[0].privateKey, 'string');

  const reopened = Wallet.load(file, devnet);
  assert.equal(reopened.isEncrypted, false);
  reopened.encrypt(passphrase);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('the passphrase can be changed in place without writing plaintext', () => {
  const oldPassphrase = 'old wallet passphrase';
  const newPassphrase = 'new wallet passphrase';
  const { file, wallet } = temporaryWallet();
  const key = wallet.defaultKey();
  const originalPrivateKey = key.privateKey;
  wallet.newKey('second');
  wallet.encrypt(oldPassphrase);

  const before = fs.readFileSync(file, 'utf8');
  const beforeData = JSON.parse(before);

  assert.throws(
    () => Wallet.load(file, devnet).changePassphrase(newPassphrase),
    /locked/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const unlocked = Wallet.load(file, devnet);
  unlocked.unlock(oldPassphrase);
  unlocked.changePassphrase(newPassphrase);

  const after = fs.readFileSync(file, 'utf8');
  const stored = JSON.parse(after);
  assert.equal(stored.version, 2);
  assert.notEqual(stored.crypto.salt, beforeData.crypto.salt);
  assert.ok(!after.includes(originalPrivateKey), 'no plaintext private key on disk');
  assert.ok(
    !after.includes(unlocked.privateKeyFor(key.address)),
    'no decrypted key material on disk',
  );
  assert.notDeepEqual(
    stored.keys.map((entry) => entry.encryptedPrivateKey.ciphertext),
    beforeData.keys.map((entry) => entry.encryptedPrivateKey.ciphertext),
  );

  assert.throws(
    () => Wallet.load(file, devnet).unlock(oldPassphrase),
    /wrong passphrase/,
  );
  const reopened = Wallet.load(file, devnet);
  reopened.unlock(newPassphrase);
  assert.equal(reopened.privateKeyFor(key.address), originalPrivateKey);

  // A rejected replacement must leave the old encryption untouched.
  const beforeShort = fs.readFileSync(file, 'utf8');
  assert.throws(
    () => reopened.changePassphrase('short'),
    /at least 8 characters/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), beforeShort);
  assert.doesNotThrow(() => Wallet.load(file, devnet).unlock(newPassphrase));

  const plain = temporaryWallet();
  assert.throws(
    () => plain.wallet.changePassphrase('irrelevant passphrase'),
    /not encrypted/,
  );
  fs.rmSync(plain.dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('an encrypted backup round-trips and refuses unsafe overwrites', () => {
  const passphrase = 'backup wallet passphrase';
  const { dir, file, wallet } = temporaryWallet();
  const address = wallet.defaultKey().address;
  const originalPrivateKey = wallet.defaultKey().privateKey;
  wallet.newKey('second');
  wallet.encrypt(passphrase);

  const backupFile = path.join(dir, 'wallet-backup.json');
  wallet.unlock(passphrase); // an unlocked wallet must still verify the passphrase
  const result = wallet.backup(backupFile, passphrase);
  assert.equal(result.keys, 2);
  // The archive is gzip and named for it, even though .gz was not given.
  assert.equal(result.path, `${backupFile}.gz`);
  assert.equal(result.bytes, fs.statSync(result.path).size);
  assert.equal(result.rawBytes, fs.statSync(file).size);
  assert.ok(result.bytes < result.rawBytes, 'the archive is smaller than the wallet');
  const stored = fs.readFileSync(result.path);
  assert.equal(stored[0], 0x1f, 'gzip magic');
  assert.equal(stored[1], 0x8b);

  const backupText = zlib.gunzipSync(stored).toString('utf8');
  assert.equal(backupText, fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.parse(backupText).version, 2);
  assert.ok(!backupText.includes(originalPrivateKey), 'backup has no plaintext key');

  // The export stamps itself in gzip's MTIME field, so `wallet restore` can say
  // which export it installed and the stamp survives a copy that resets times.
  assert.equal(backupArchiveTime(result.path), result.at, 'read back what was returned');
  assert.ok(
    Math.abs(Date.parse(result.at) - Date.now()) < 60_000,
    'the stamp is the moment the export was written',
  );
  const archiveStamp = result.at;
  fs.utimesSync(result.path, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(
    backupArchiveTime(result.path),
    archiveStamp,
    'a copied archive keeps its own stamp rather than the file time',
  );

  // An archive from before the stamp was recorded carries zero there; it falls
  // back to the file's modification time instead of claiming 1970.
  const unstamped = path.join(dir, 'unstamped.gz');
  const zeroed = Buffer.from(stored);
  zeroed.writeUInt32LE(0, 4);
  fs.writeFileSync(unstamped, zeroed);
  fs.utimesSync(unstamped, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(backupArchiveTime(unstamped), new Date(2020, 0, 1).toISOString());

  // An explicit .gz destination is used as given, not doubled.
  const explicit = wallet.backup(path.join(dir, 'explicit.gz'), passphrase);
  assert.equal(explicit.path, path.join(dir, 'explicit.gz'));

  const missing = path.join(dir, 'missing.json');
  assert.throws(
    () => wallet.backup(missing, 'wrong backup passphrase'),
    /wrong passphrase/,
  );
  assert.equal(fs.existsSync(missing), false);
  assert.throws(
    () => wallet.backup(backupFile, passphrase),
    /backup file already exists/,
  );

  const target = path.join(dir, 'restored', 'wallet.json');
  assert.throws(
    () => Wallet.restore(result.path, target, devnet, 'wrong backup passphrase'),
    /wrong passphrase/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.restore.tmp`), false);

  const restored = Wallet.restore(result.path, target, devnet, passphrase);
  assert.equal(restored.defaultKey().address, address);
  assert.equal(restored.isEncrypted, true);
  assert.equal(restored.isUnlocked, false);

  const installed = fs.readFileSync(target, 'utf8');
  // The wallet on disk is plain JSON: decompression happens on restore.
  assert.equal(installed[0], '{');
  assert.throws(
    () => Wallet.restore(result.path, target, devnet, passphrase),
    /already exists/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), installed);

  const overwritten = Wallet.restore(result.path, target, devnet, passphrase, {
    force: true,
  });
  assert.equal(overwritten.defaultKey().address, address);

  // A backup written before compression existed is plain JSON, and still
  // restores with this code.
  const legacy = path.join(dir, 'legacy-wallet.json');
  fs.copyFileSync(file, legacy);
  const legacyTarget = path.join(dir, 'legacy-restore', 'wallet.json');
  const legacyRestored = Wallet.restore(legacy, legacyTarget, devnet, passphrase);
  assert.equal(legacyRestored.defaultKey().address, address);
  assert.equal(legacyRestored.isEncrypted, true);
  assert.equal(fs.readFileSync(legacyTarget, 'utf8'), fs.readFileSync(file, 'utf8'));

  const plain = temporaryWallet();
  const plainBackup = path.join(plain.dir, 'plain-backup.json');
  assert.throws(
    () => plain.wallet.backup(plainBackup, 'irrelevant passphrase'),
    /not encrypted/,
  );
  assert.equal(fs.existsSync(plainBackup), false);

  fs.copyFileSync(plain.file, plainBackup);
  assert.throws(
    () =>
      Wallet.restore(
        plainBackup,
        path.join(plain.dir, 'restored.json'),
        devnet,
        'irrelevant passphrase',
      ),
    /not encrypted/,
  );

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(plain.dir, { recursive: true, force: true });
});

test('wallet restore names the export it installed', async () => {
  const passphrase = 'restore names the export';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-restore-'));
  const sourceDir = path.join(root, 'source', 'devnet');
  fs.mkdirSync(sourceDir, { recursive: true });
  const wallet = Wallet.create(
    path.join(sourceDir, 'wallet.json'),
    devnet,
    'cold storage',
  );
  wallet.newKey('treasury');
  wallet.encrypt(passphrase);
  const archive = wallet.backup(path.join(root, 'cold'), passphrase);

  // As if the export had been copied around before use: the file time is years
  // off, so only the archive's own stamp can identify it.
  fs.utimesSync(archive.path, new Date(2020, 0, 1), new Date(2020, 0, 1));

  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        path.join(root, 'restored'),
        'wallet',
        'restore',
        archive.path,
      ],
      { timeout: 30_000, env: { ...process.env, DOUBLOOM_PASSPHRASE: passphrase } },
    );
    const text = stdout.replace(/\x1b\[[0-9;]*m/g, '');

    // The stamp printed is the export's own, in the same `YYYY-MM-DD HH:MM:SS
    // UTC` form every other timestamp uses, not the install time.
    const stamp = `${new Date(archive.at).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    assert.match(
      text,
      new RegExp(`backup time\\s+${stamp.replace(/[-:]/g, '\\$&')}`),
      `the export the restore installed is named (${stamp})`,
    );
    // The age is read at run time, so a restore in the same second says "just
    // now" rather than inventing a second.
    assert.match(
      text,
      /\((?:just now|\d+s ago)\)/,
      'with how long ago it was made',
    );

    // The labels travel in the archive, so they identify whose keys came back.
    assert.match(text, /cold storage/);
    assert.match(text, /treasury/);
    assert.ok(fs.existsSync(path.join(root, 'restored', 'devnet', 'wallet.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** CRC-32 as gzip's trailer wants it; zlib exposes none on Node 18. */
function gzipCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a wallet backup from the documented bytes alone, so the reader is
 * checked against the format rather than against whatever the writer emits
 * today. Any change to the container has to keep this restorable.
 */
function handBuiltWalletBackup(walletBytes, mtimeSeconds) {
  const header = Buffer.alloc(10);
  header[0] = 0x1f; // gzip magic
  header[1] = 0x8b;
  header[2] = 0x08; // deflate
  header[3] = 0x00; // no optional header fields
  header.writeUInt32LE(mtimeSeconds, 4);
  header[8] = 0x00; // XFL
  header[9] = 0x03; // OS: Unix, and never read back

  const body = zlib.deflateRawSync(walletBytes);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(gzipCrc32(walletBytes), 0);
  trailer.writeUInt32LE(walletBytes.length >>> 0, 4);
  return Buffer.concat([header, body, trailer]);
}

test('wallet backups match the documented container format', () => {
  const passphrase = 'documented format passphrase';
  const { dir, file, wallet } = temporaryWallet();
  wallet.newKey('treasury');
  wallet.encrypt(passphrase);

  try {
    const result = wallet.backup(path.join(dir, 'export'), passphrase);
    const bytes = fs.readFileSync(result.path);
    const walletBytes = fs.readFileSync(file);

    // The header is exactly what the README documents: gzip, deflate, no
    // optional fields, and an MTIME that is not zlib's zero.
    assert.equal(bytes[0], 0x1f, 'gzip magic');
    assert.equal(bytes[1], 0x8b, 'gzip magic');
    assert.equal(bytes[2], 0x08, 'deflate');
    assert.equal(bytes[3], 0x00, 'no optional header fields');
    assert.equal(
      bytes.readUInt32LE(4),
      Math.floor(Date.parse(result.at) / 1000),
      'MTIME holds the export time to the second',
    );
    assert.notEqual(bytes.readUInt32LE(4), 0, 'MTIME is set, not left at zero');

    // The payload is the wallet file byte for byte: version 2, encrypted keys,
    // no wrapper object around it and no plaintext.
    const payload = zlib.gunzipSync(bytes);
    assert.deepEqual(payload, walletBytes);
    const text = payload.toString('utf8');
    assert.equal(JSON.parse(text).version, 2);
    assert.ok(text.includes('"encryptedPrivateKey"'), 'keys stay encrypted');
    assert.ok(!text.includes('"privateKey":'), 'no plaintext key in the payload');

    // An archive assembled from the documented bytes restores, so old exports
    // keep working regardless of what the writer does later.
    const handBuilt = path.join(dir, 'hand-built.gz');
    const stamp = '2025-06-01T12:00:00.000Z';
    fs.writeFileSync(
      handBuilt,
      handBuiltWalletBackup(walletBytes, Math.floor(Date.parse(stamp) / 1000)),
    );
    assert.equal(backupArchiveTime(handBuilt), stamp, 'the documented MTIME reads back');
    const restored = Wallet.restore(
      handBuilt,
      path.join(dir, 'hand-built-restore', 'wallet.json'),
      devnet,
      passphrase,
    );
    assert.equal(restored.listKeys().length, 2);
    assert.equal(restored.defaultKey().label, 'primary');
    assert.equal(restored.isEncrypted, true);

    // The trailer is part of the contract too: a corrupted body must fail rather
    // than install a wallet that only looks restored. gzip's CRC-32 is what
    // catches it (zlib reports "incorrect data check"), so a future format that
    // dropped the checksum would show up here.
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 12] ^= 0xff;
    const corruptPath = path.join(dir, 'corrupt.gz');
    const corruptTarget = path.join(dir, 'corrupt-restore', 'wallet.json');
    fs.writeFileSync(corruptPath, corrupt);
    assert.throws(
      () => Wallet.restore(corruptPath, corruptTarget, devnet, passphrase),
      (error) =>
        error.code === 'Z_DATA_ERROR' ||
        /incorrect data check|invalid|unexpected/i.test(error.message),
      'a corrupted archive is refused by the checksum',
    );
    assert.equal(fs.existsSync(corruptTarget), false, 'nothing installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node backup restores the chain and encrypted wallet together', () => {
  const passphrase = 'node backup passphrase';
  const { dir, chainFile, walletFile, chain, wallet, privateKey } =
    temporaryNode();
  const address = wallet.defaultKey().address;
  wallet.encrypt(passphrase);

  const archivePath = path.join(dir, 'node-backup.json');
  const result = createNodeBackup({
    params: devnet,
    chainFile,
    walletFile,
    destination: archivePath,
    passphrase,
    createdAt: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(result.height, chain.height);
  assert.equal(result.tip, headerHash(chain.tip.header));
  assert.equal(result.keys, 1);
  assert.deepEqual(result.addresses, [address]);

  // The archive is gzip on disk and still holds the same JSON document.
  assert.equal(result.path, `${archivePath}.gz`);
  const buffer = fs.readFileSync(result.path);
  assert.equal(buffer[0], 0x1f, 'gzip magic byte 1');
  assert.equal(buffer[1], 0x8b, 'gzip magic byte 2');
  assert.ok(
    result.bytes < result.rawBytes,
    `archive shrinks (${result.bytes} < ${result.rawBytes})`,
  );
  const text = zlib.gunzipSync(buffer).toString('utf8');
  assert.ok(!text.includes(privateKey), 'archive has no plaintext private key');
  const archive = JSON.parse(text);
  assert.equal(archive.format, 'doubloom-node-backup');
  assert.equal(archive.network, devnet.name);
  assert.equal(archive.chain.blocks.length, chain.blocks.length);
  assert.equal(archive.chain.mempool.length, 0);
  assert.equal(archive.wallet.version, 2);

  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-restore-'));
  const targetChain = path.join(targetDir, devnet.name, 'chain.json');
  const targetWallet = path.join(targetDir, devnet.name, 'wallet.json');
  const options = {
    source: result.path,
    params: devnet,
    chainFile: targetChain,
    walletFile: targetWallet,
  };

  assert.throws(
    () => restoreNodeBackup({ ...options, passphrase: 'wrong node passphrase' }),
    /wrong passphrase/,
  );
  assert.equal(fs.existsSync(targetChain), false);
  assert.equal(fs.existsSync(targetWallet), false);
  assert.equal(fs.existsSync(`${targetChain}.restore.tmp`), false);
  assert.equal(fs.existsSync(`${targetWallet}.restore.tmp`), false);

  const restored = restoreNodeBackup({ ...options, passphrase });
  assert.equal(restored.height, chain.height);
  assert.equal(restored.tip, headerHash(chain.tip.header));
  assert.deepEqual(restored.addresses, [address]);

  const loadedChain = loadChain(devnet, targetChain);
  assert.equal(loadedChain.height, chain.height);
  const loadedWallet = Wallet.load(targetWallet, devnet);
  loadedWallet.unlock(passphrase);
  assert.equal(loadedWallet.defaultKey().address, address);

  const chainBefore = fs.readFileSync(targetChain, 'utf8');
  assert.throws(
    () => restoreNodeBackup({ ...options, passphrase }),
    /already exists/,
  );
  assert.equal(fs.readFileSync(targetChain, 'utf8'), chainBefore);
  assert.doesNotThrow(() =>
    restoreNodeBackup({ ...options, passphrase, force: true }),
  );

  // An archive written before compression existed still restores as-is.
  const legacyPath = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacyPath, text);
  const legacy = restoreNodeBackup({
    ...options,
    source: legacyPath,
    passphrase,
    force: true,
  });
  assert.equal(legacy.height, chain.height);
  assert.deepEqual(legacy.addresses, [address]);

  assert.throws(
    () =>
      createNodeBackup({
        params: devnet,
        chainFile,
        walletFile,
        destination: archivePath,
        passphrase,
      }),
    /backup file already exists/,
  );

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('node backups reject plaintext wallets and tampered archives', () => {
  const passphrase = 'node refusal passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  const plaintextWallet = JSON.parse(fs.readFileSync(walletFile, 'utf8'));

  const refusedPath = path.join(dir, 'plaintext-wallet.json');
  assert.throws(
    () =>
      createNodeBackup({
        params: devnet,
        chainFile,
        walletFile,
        destination: refusedPath,
        passphrase,
      }),
    /not encrypted/,
  );
  assert.equal(fs.existsSync(refusedPath), false);

  wallet.encrypt(passphrase);
  const archivePath = path.join(dir, 'node-backup.json');
  const created = createNodeBackup({
    params: devnet,
    chainFile,
    walletFile,
    destination: archivePath,
    passphrase,
  });
  const archive = readNodeArchive(created.path);

  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-restore-'));
  const targetChain = path.join(targetDir, devnet.name, 'chain.json');
  const targetWallet = path.join(targetDir, devnet.name, 'wallet.json');
  const options = {
    params: devnet,
    chainFile: targetChain,
    walletFile: targetWallet,
    passphrase,
  };

  const tampered = JSON.parse(JSON.stringify(archive));
  tampered.chain.blocks[1].header.merkleRoot = '0'.repeat(64);
  const tamperedFile = path.join(dir, 'tampered.json.gz');
  writeNodeArchive(tamperedFile, tampered);
  // Altering the merkle root also changes the header hash, so either the
  // proof of work or the merkle root check can reject it first.
  assert.throws(
    () => restoreNodeBackup({ ...options, source: tamperedFile }),
    /proof of work does not meet target|merkle root mismatch/,
  );
  assert.equal(fs.existsSync(targetChain), false);

  const badSummary = JSON.parse(JSON.stringify(archive));
  badSummary.summary.height += 1;
  // Written as plain JSON: archives from before compression are still read.
  const badSummaryFile = path.join(dir, 'bad-summary.json');
  fs.writeFileSync(badSummaryFile, JSON.stringify(badSummary));
  assert.throws(
    () => restoreNodeBackup({ ...options, source: badSummaryFile }),
    /summary does not match/,
  );

  const wrongNetwork = JSON.parse(JSON.stringify(archive));
  wrongNetwork.network = 'mainnet';
  const wrongNetworkFile = path.join(dir, 'wrong-network.json.gz');
  writeNodeArchive(wrongNetworkFile, wrongNetwork);
  assert.throws(
    () => restoreNodeBackup({ ...options, source: wrongNetworkFile }),
    /belongs to the mainnet network/,
  );

  const plaintextArchive = JSON.parse(JSON.stringify(archive));
  plaintextArchive.wallet = plaintextWallet;
  const plaintextArchiveFile = path.join(dir, 'plaintext-wallet-archive.json.gz');
  writeNodeArchive(plaintextArchiveFile, plaintextArchive);
  assert.throws(
    () => restoreNodeBackup({ ...options, source: plaintextArchiveFile }),
    /refusing to restore plaintext keys/,
  );
  assert.equal(fs.existsSync(targetChain), false);
  assert.equal(fs.existsSync(targetWallet), false);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('automatic backups run on a schedule and retain only the newest archives', async () => {
  const passphrase = 'scheduled backup passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir);
  const unrelated = path.join(backupDir, 'notes.txt');
  fs.writeFileSync(unrelated, 'keep me');

  const logs = [];
  const errors = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    intervalMs: 40,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 0,
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const archives = () =>
    fs
      .readdirSync(backupDir)
      .filter(
        (name) =>
          name.startsWith('doubloom-devnet-backup-') &&
          name.endsWith('.json.gz'),
      );

  const deadline = Date.now() + 8000;
  while (logs.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  schedule.stop();

  assert.ok(logs.length >= 3, `expected three backups, saw ${logs.length}`);
  assert.equal(errors.length, 0);
  // Three runs inside one hour are one hourly bucket, so the tier keeps the
  // newest of them; the multi-bucket behaviour is covered below.
  assert.equal(archives().length, 1);
  assert.ok(fs.existsSync(unrelated), 'retention leaves unrelated files alone');
  assert.ok(logs.some((line) => line.includes('removed 1 old backup')));

  const newest = archives()
    .map((name) => ({
      name,
      modified: fs.statSync(path.join(backupDir, name)).mtimeMs,
    }))
    .sort((left, right) => right.modified - left.modified)[0];
  const archive = readNodeArchive(path.join(backupDir, newest.name));
  assert.equal(archive.format, 'doubloom-node-backup');
  assert.equal(archive.summary.height, chain.height);

  const status = schedule.status();
  assert.equal(status.enabled, true);
  assert.equal(status.nextRunAt, null, 'stop clears the next run time');
  assert.deepEqual(status.retention, { hourly: 2, daily: 0, weekly: 0 });
  assert.equal(status.lastBackup.height, chain.height);
  assert.equal(status.lastBackup.path, path.join(backupDir, newest.name));
  assert.ok(!Number.isNaN(Date.parse(status.lastBackup.at)));
  assert.equal(status.lastError, null);
  const persisted = loadBackupStatus({
    statusFile: backupStatusFile(chainFile),
    network: devnet.name,
  });
  assert.equal(persisted.lastBackup.path, status.lastBackup.path);
  assert.equal(persisted.lastBackup.height, chain.height);

  const countAfterStop = archives().length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(archives().length, countAfterStop, 'stop clears the timer');
  assert.throws(() => schedule.runNow(), /stopped/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention keeps the newest archive of each hour, day and week', () => {
  const archive = (stamp) => {
    const at = new Date(stamp);
    return { name: backupFileName(devnet.name, at), at };
  };
  const archives = [
    archive('2026-10-31T12:00:00Z'),
    archive('2026-10-31T11:30:00Z'),
    archive('2026-10-31T11:00:00Z'),
    archive('2026-10-31T10:00:00Z'),
    archive('2026-10-30T12:00:00Z'),
    archive('2026-10-29T12:00:00Z'),
    archive('2026-10-28T12:00:00Z'),
    archive('2026-10-24T12:00:00Z'),
    archive('2026-10-17T12:00:00Z'),
    archive('2026-10-10T12:00:00Z'),
  ];
  const byName = Object.fromEntries(archives.map((entry) => [entry.name, entry.at]));
  const keep = (retention) =>
    [...selectRetained(archives, retention)].sort(
      (left, right) => byName[right] - byName[left],
    );

  // Only the newest archive, regardless of how many share its hour.
  assert.deepEqual(keep({ hourly: 1, daily: 0, weekly: 0 }), [archives[0].name]);

  // Two days, one archive each, even though the newest day holds the morning.
  assert.deepEqual(keep({ hourly: 0, daily: 2, weekly: 0 }), [
    archives[0].name,
    archives[4].name,
  ]);

  // Two ISO weeks: the week of 31 October and the week before it.
  assert.deepEqual(keep({ hourly: 0, daily: 0, weekly: 2 }), [
    archives[0].name,
    archives[7].name,
  ]);

  // Tiers combine: the two newest hours, the three newest days and the two
  // newest weeks, unioned. The newest archive fills all three of its slots, so
  // the day and week slots fall to the next distinct representatives rather
  // than to a same-day leftover.
  assert.deepEqual(
    keep({ hourly: 2, daily: 3, weekly: 2 }).sort(),
    [archives[0], archives[1], archives[4], archives[5], archives[7]]
      .map((entry) => entry.name)
      .sort(),
  );
});

test('retention prunes archive files by tier and leaves other files alone', () => {
  const { dir } = temporaryNode();
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const name = (stamp) => backupFileName(devnet.name, new Date(stamp));
  const stamps = [
    '2026-10-31T12:00:00Z',
    '2026-10-31T11:00:00Z',
    '2026-10-31T10:00:00Z',
    '2026-10-31T09:00:00Z',
    '2026-10-30T12:00:00Z',
    '2026-10-29T12:00:00Z',
    '2026-10-20T12:00:00Z',
  ];
  for (const stamp of stamps) {
    fs.writeFileSync(path.join(backupDir, name(stamp)), '{}');
  }
  fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'keep me');

  try {
    const removed = pruneBackups({
      directory: backupDir,
      network: devnet.name,
      retention: { hourly: 3, daily: 2, weekly: 0 },
    });
    const left = fs.readdirSync(backupDir).sort();

    // The three newest hours plus the newest archive of each of the two newest
    // days; the newest archive covers both its hour and its day.
    assert.deepEqual(left, [
      'notes.txt',
      name('2026-10-31T12:00:00Z'),
      name('2026-10-31T11:00:00Z'),
      name('2026-10-31T10:00:00Z'),
      name('2026-10-30T12:00:00Z'),
    ].sort());
    assert.equal(removed.length, 3);
    assert.ok(removed.includes(name('2026-10-31T09:00:00Z')));
    assert.ok(removed.includes(name('2026-10-29T12:00:00Z')));
    assert.ok(removed.includes(name('2026-10-20T12:00:00Z')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retention limits default, validate and upgrade older status files', () => {
  assert.deepEqual(normalizeRetention(), { hourly: 24, daily: 7, weekly: 4 });
  assert.deepEqual(normalizeRetention({ daily: 3 }), {
    hourly: 24,
    daily: 3,
    weekly: 4,
  });
  assert.throws(
    () => normalizeRetention({ hourly: -1 }),
    /hourly must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeRetention({ hourly: 0, daily: 0, weekly: 0 }),
    /at least one archive/,
  );

  const { dir, chainFile, walletFile } = temporaryNode();
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase: 'unused for scheduling',
    intervalMs: 60_000,
    firstDelayMs: 600_000,
    log: () => {},
    logError: () => {},
  });
  try {
    assert.deepEqual(schedule.status().retention, {
      hourly: 24,
      daily: 7,
      weekly: 4,
    });
  } finally {
    schedule.stop();
  }

  // A status file from before tiers existed carries a single `keep` count.
  fs.writeFileSync(
    backupStatusFile(chainFile),
    JSON.stringify({
      version: 1,
      network: devnet.name,
      pid: process.pid,
      directory: path.join(dir, 'backups'),
      intervalMs: 60_000,
      keep: 3,
      nextRunAt: null,
    }),
  );
  const legacy = loadBackupStatus({
    statusFile: backupStatusFile(chainFile),
    network: devnet.name,
  });
  assert.deepEqual(legacy.retention, { hourly: 3, daily: 0, weekly: 0 });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('one backup worker is reused across runs instead of a thread per backup', async () => {
  const passphrase = 'reused worker passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupWorker = createBackupWorker();
  const backupDir = path.join(dir, 'backups');

  try {
    assert.deepEqual(backupWorker.stats(), {
      spawned: 0,
      jobs: 0,
      pending: 0,
      queued: 0,
    });

    const first = await backupWorker.runBackup({
      params: devnet,
      chainFile,
      walletFile,
      destination: path.join(backupDir, 'first'),
      passphrase,
    });
    const second = await backupWorker.runBackup({
      params: devnet,
      chainFile,
      walletFile,
      destination: path.join(backupDir, 'second'),
      passphrase,
    });

    assert.equal(first.height, chain.height);
    assert.equal(second.height, chain.height);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(backupWorker.stats(), {
      spawned: 1,
      jobs: 2,
      pending: 0,
      queued: 0,
    });

    // A verification uses the same thread as the backups before it.
    await backupWorker.verifyBackup({
      params: devnet,
      source: second.path,
      passphrase,
      tempRoot: dir,
    });
    assert.equal(backupWorker.stats().spawned, 1);
    assert.equal(backupWorker.stats().jobs, 3);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('doubloom-verify-')), []);

    // Closing stops that thread; later work is refused rather than silently
    // starting a new one behind a shut-down node.
    backupWorker.close();
    await assert.rejects(
      () =>
        backupWorker.runBackup({
          params: devnet,
          chainFile,
          walletFile,
          destination: path.join(backupDir, 'late'),
          passphrase,
        }),
      /backup worker is stopped/,
    );
  } finally {
    backupWorker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a closing node lets an in-flight backup finish', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'closing backup passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupDir = path.join(dir, 'backups');

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  const node = startNode({
    chain,
    params: devnet,
    chainFile,
    walletFile,
    wallet,
    port: 0,
    backup: {
      directory: backupDir,
      passphrase,
      intervalMs: 60_000,
      // Long enough that only the manual run below is in flight.
      firstDelayMs: 600_000,
    },
  });

  try {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The job is handed to the worker synchronously, so close() always sees it
    // pending and has to wait for it rather than terminating mid-write.
    const running = node.backups.runNow();
    const closing = node.close();
    const result = await running;
    await closing;

    assert.ok(fs.existsSync(result.path), 'the archive was completed');
    assert.ok(fs.statSync(result.path).size > 0);
    assert.equal(fs.readFileSync(result.path)[0], 0x1f, 'gzip magic byte 1');

    // And it is a whole archive, not a truncated one: it restores.
    const target = path.join(dir, 'restored');
    const restored = restoreNodeBackup({
      source: result.path,
      params: devnet,
      chainFile: path.join(target, 'chain.json'),
      walletFile: path.join(target, 'wallet.json'),
      passphrase,
    });
    assert.equal(restored.height, chain.height);
    assert.deepEqual(restored.addresses, [wallet.defaultKey().address]);
  } finally {
    await node.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node backups write and validate on a worker thread without blocking the loop', async () => {
  const passphrase = 'worker backup passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupWorker = createBackupWorker();

  // A main-thread heartbeat. Compressing the archive, replaying its chain and
  // running scrypt on the passphrase all happen on the worker, so these ticks
  // must keep firing while the backup is in flight.
  let ticks = 0;
  let maxGapMs = 0;
  let lastTick = Date.now();
  const heartbeat = setInterval(() => {
    const nowMs = Date.now();
    maxGapMs = Math.max(maxGapMs, nowMs - lastTick);
    lastTick = nowMs;
    ticks += 1;
  }, 10);

  const backupDir = path.join(dir, 'backups');
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 600_000,
    runBackup: (job) => backupWorker.runBackup(job),
    log: () => {},
    logError: () => {},
  });

  try {
    const startedAt = Date.now();
    const pending = schedule.runNow();
    // The run continues on another thread, so the guard has to hold here.
    assert.throws(() => schedule.runNow(), /already running/);
    assert.equal(schedule.status().running, true);

    const result = await pending;
    const elapsedMs = Date.now() - startedAt;
    clearInterval(heartbeat);

    assert.equal(result.height, chain.height);
    assert.equal(result.keys, 1);
    assert.deepEqual(result.addresses, [wallet.defaultKey().address]);
    assert.match(result.tip, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(result.path), 'the archive was written');
    assert.equal(path.dirname(result.path), backupDir);
    assert.ok(result.bytes > 0);

    const status = schedule.status();
    assert.equal(status.running, false);
    assert.equal(status.lastError, null);
    assert.equal(status.lastBackup.path, result.path);
    assert.equal(status.lastBackup.height, chain.height);

    assert.ok(
      ticks >= 5,
      `the event loop kept running during the backup (${ticks} ticks in ${elapsedMs}ms)`,
    );
    assert.ok(
      maxGapMs < elapsedMs,
      `no single stall covered the whole backup (max gap ${maxGapMs}ms of ${elapsedMs}ms)`,
    );

    // Failures cross the thread boundary as rejections, and leave no archive.
    const failed = path.join(backupDir, 'wrong-passphrase');
    await assert.rejects(
      () =>
        backupWorker.runBackup({
          params: devnet,
          chainFile,
          walletFile,
          destination: failed,
          passphrase: 'not the passphrase',
        }),
      /wrong passphrase/,
    );
    assert.equal(
      fs.existsSync(`${failed}.gz`),
      false,
      'a failed backup leaves no archive',
    );
  } finally {
    clearInterval(heartbeat);
    schedule.stop();
    backupWorker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale schedule logs a recovery line once a fresh archive is written', async () => {
  const passphrase = 'recovery line passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const logs = [];
  const errors = [];
  // A shiftable clock decides the archive's age without waiting for it.
  let clockOffset = 0;
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 0,
    maxAgeMs: 2000,
    watchdogMs: 20,
    now: () => new Date(Date.now() + clockOffset),
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const recoveries = () =>
    logs.filter((line) => line.startsWith('backup schedule recovered:'));
  const waitUntil = async (check, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  try {
    assert.ok(
      await waitUntil(() => logs.some((line) => line.startsWith('backup written'))),
      'the first backup ran',
    );
    // Nothing was stale yet, so the first archive is written quietly.
    assert.equal(recoveries().length, 0, 'a fresh run is not called a recovery');

    clockOffset = 5000;
    assert.ok(
      await waitUntil(() => errors.some((line) => line.includes('past the'))),
      'the archive went stale',
    );

    // A successful run ends the episode and says so, naming the old age, the
    // limit and the height that is now archived.
    const result = await schedule.runNow();
    assert.equal(recoveries().length, 1, 'the recovery is logged once');
    assert.match(
      recoveries()[0],
      /^backup schedule recovered: the previous archive was [\d.]+ ?(s|min|h) old, past the [\d.]+ ?(s|min|h) limit; fresh archives are being written again \(height \d+\)$/,
    );
    assert.ok(
      recoveries()[0].includes(`height ${result.height}`),
      'the recovery names the archived height',
    );

    // The line belongs to the episode, not to every later run.
    await schedule.runNow();
    assert.equal(recoveries().length, 1, 'a healthy run logs no recovery');
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale-to-fresh recovery is kept in the persisted recovery history', async () => {
  const passphrase = 'stale history passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const statusFile = backupStatusFile(chainFile);
  const logs = [];
  let clockOffset = 0;
  const options = {
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60_000,
    firstDelayMs: 0,
    maxAgeMs: 1_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    now: () => new Date(Date.now() + clockOffset),
    log: (message) => logs.push(message),
    logError: () => {},
  };
  const schedule = startBackupSchedule(options);
  let restarted = null;

  try {
    await schedule.runNow();
    assert.equal(
      schedule.status().recoveryHistory.length,
      0,
      'a fresh run is not a recovery',
    );

    // The archive ages past the limit, so the next run replaces a stale one.
    clockOffset = 5_000;
    await schedule.runNow();
    const status = schedule.status();
    assert.equal(status.recoveryHistory.length, 1);
    assert.match(
      status.recoveryHistory[0].reason,
      /^the previous archive was [\d.]+s old, past the 1s limit; fresh archives are being written again \(height \d+\)$/,
    );
    assert.deepEqual(status.recoveryHistory[0], status.lastRecovery);
    assert.match(
      logs.join('\n'),
      /backup schedule recovered: the previous archive was [\d.]+s old/,
    );

    // It is on disk with the rest of the status...
    const persisted = loadBackupStatus({ statusFile, network: devnet.name });
    assert.deepEqual(persisted.recoveryHistory, status.recoveryHistory);
    assert.deepEqual(persisted.lastRecovery, status.lastRecovery);
    schedule.stop();

    // ...so a node that starts later still reports it, even though this
    // process never saw the stale archive itself.
    restarted = startBackupSchedule({ ...options, firstDelayMs: 60_000 });
    assert.deepEqual(restarted.status().recoveryHistory, status.recoveryHistory);
    assert.deepEqual(restarted.status().lastRecovery, status.lastRecovery);
  } finally {
    restarted?.stop();
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manual backup can be exported outside the retention directory', async () => {
  const passphrase = 'export passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupDir = path.join(dir, 'backups');
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 600_000,
    log: () => {},
    logError: () => {},
  });

  try {
    const target = path.join(dir, 'usb', 'node-snapshot.json');
    const result = await schedule.runNow({ destination: target });

    // The suffix is added exactly as it is for an archive in the directory.
    assert.equal(result.path, `${target}.gz`);
    assert.ok(fs.existsSync(result.path));
    assert.equal(result.height, chain.height);

    // A copy that restores is the only export worth having.
    const restored = restoreNodeBackup({
      source: result.path,
      params: devnet,
      chainFile: path.join(dir, 'restored', 'chain.json'),
      walletFile: path.join(dir, 'restored', 'wallet.json'),
      passphrase,
    });
    assert.equal(restored.height, chain.height);

    // It is not a retention entry: the directory is untouched and the schedule
    // still reports no backup of its own.
    assert.deepEqual(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
      [],
    );
    assert.equal(schedule.status().lastBackup, null);
    assert.equal(schedule.status().lastAttemptAt, null);

    // A path that cannot mean "outside this directory" is refused before a run
    // starts, so the schedule is left able to try again.
    assert.throws(
      () => schedule.runNow({ destination: 'relative.json' }),
      /absolute path/,
    );
    assert.throws(
      () =>
        schedule.runNow({ destination: path.join(backupDir, 'inside.json') }),
      /inside the retention directory/,
    );
    assert.equal(schedule.status().running, false);

    const ordinary = await schedule.runNow();
    assert.equal(path.dirname(ordinary.path), path.resolve(backupDir));
    assert.equal(schedule.status().lastBackup.height, chain.height);
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup reports how much of its chain is written and verified', () => {
  const passphrase = 'progress passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const seen = [];

  try {
    const result = createNodeBackup({
      params: devnet,
      chainFile,
      walletFile,
      destination: path.join(dir, 'progress', 'archive.json'),
      passphrase,
      onProgress: (progress) => seen.push({ ...progress }),
    });

    assert.ok(result.bytes > 0);
    // The chunked write produces exactly the archive one `JSON.stringify` would
    // have: parsing and re-serializing it changes nothing.
    const text = zlib.gunzipSync(fs.readFileSync(result.path)).toString('utf8');
    assert.equal(JSON.stringify(JSON.parse(text)), text);
    assert.ok(seen.length >= 3, `several reports: ${JSON.stringify(seen)}`);
    assert.equal(seen[0].phase, 'writing');
    assert.equal(seen[0].percent, 0);
    assert.equal(seen[0].total, chain.height + 1);
    assert.equal(seen[seen.length - 1].phase, 'verifying');
    assert.equal(seen[seen.length - 1].percent, 100);
    assert.equal(seen[seen.length - 1].done, chain.height + 1);
    assert.ok(
      seen.some(
        (progress) => progress.phase === 'verifying' && progress.percent >= 50,
      ),
      'verification starts from the half-way mark',
    );

    // The figure only moves forward, stays inside the bar, and never counts
    // more blocks than the chain holds.
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index].percent >= seen[index - 1].percent);
      assert.ok(seen[index].done <= seen[index].total);
    }
    for (const progress of seen) {
      assert.ok(progress.percent >= 0 && progress.percent <= 100);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup progress crosses the worker thread to its caller', async () => {
  const passphrase = 'worker progress passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const worker = createBackupWorker();
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60_000,
    firstDelayMs: 600_000,
    runBackup: (job) => worker.runBackup(job),
    log: () => {},
    logError: () => {},
  });
  const seen = [];

  try {
    await schedule.runNow({ onProgress: (progress) => seen.push({ ...progress }) });
    assert.ok(seen.length >= 2, `progress arrives from the thread: ${seen.length}`);
    assert.equal(seen[0].phase, 'writing');
    assert.equal(seen[seen.length - 1].percent, 100);
    assert.equal(seen[seen.length - 1].total, chain.height + 1);
  } finally {
    schedule.stop();
    worker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling the backup worker leaves it able to run again', async () => {
  const passphrase = 'worker cancel passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = stoppableNode(passphrase);
  const worker = createBackupWorker();

  try {
    const pending = worker.runBackup({
      params: devnet,
      chainFile,
      walletFile,
      destination: path.join(dir, 'run', 'cancel-me.json'),
      passphrase,
    });
    // The thread is already working: the archive takes seconds on this chain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(worker.cancelRunning(), true);

    const error = await pending.then(
      () => null,
      (reason) => reason,
    );
    assert.ok(error, 'the cancelled job rejects rather than resolving');
    assert.equal(error.cancelled, true);
    assert.equal(worker.cancelRunning(), false, 'nothing is running any more');

    // The thread is replaced rather than left dead: the next job still works.
    const result = await worker.runBackup({
      params: devnet,
      chainFile,
      walletFile,
      destination: path.join(dir, 'run', 'after.json'),
      passphrase,
    });
    assert.ok(fs.existsSync(result.path));
    assert.equal(result.height, chain.height);
  } finally {
    worker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a running backup can be cancelled and its archive discarded', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'cancel passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = stoppableNode(passphrase);
  const backupDir = path.join(dir, 'backups');

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  let node = null;
  const listening = async (instance) => {
    const deadline = Date.now() + 3000;
    while (!instance.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${instance.server.address().port}`;
  };
  const jobOf = async (url, id) =>
    (await (await fetch(`${url}/api/backup/jobs/${id}`)).json()).job;

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 60 * 60_000,
      },
    });
    const url = await listening(node);

    const created = await (await fetch(`${url}/api/backup`, { method: 'POST' })).json();
    assert.equal(created.job.state, 'running');

    // Cancel while the archive is being re-verified: the file exists by then, so
    // stopping has something to throw away.
    let job = created.job;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      job = await jobOf(url, created.job.id);
      if (job.progress?.phase === 'verifying') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      job.progress?.phase,
      'verifying',
      `the run reached verification: ${JSON.stringify(job.progress)}`,
    );

    const response = await fetch(`${url}/api/backup/jobs/${created.job.id}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.job.state, 'cancelled');
    assert.equal(body.job.error, null);
    assert.match(body.job.discarded, /\.json\.gz$/);
    assert.ok(!fs.existsSync(body.job.discarded), 'the archive is gone');
    assert.equal(body.status.lastBackup, null, 'a cancelled run is not a backup');
    assert.deepEqual(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
      [],
      'nothing is left in the retention directory',
    );
    assert.ok(
      logs.some((line) => line.includes('backup cancelled: discarded')),
      'the log names what was thrown away',
    );

    // The verdict sticks, and stopping it again is a conflict, not a new event.
    assert.equal((await jobOf(url, created.job.id)).state, 'cancelled');
    const again = await fetch(`${url}/api/backup/jobs/${created.job.id}`, {
      method: 'DELETE',
    });
    assert.equal(again.status, 409);

    // The node is not left unable to back up.
    const next = await (await fetch(`${url}/api/backup`, { method: 'POST' })).json();
    let finished = next.job;
    const settleBy = Date.now() + 30_000;
    while (finished.state === 'running' && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = await jobOf(url, next.job.id);
    }
    assert.equal(finished.state, 'succeeded');
    assert.ok(fs.existsSync(finished.backup.path));
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the explorer offers to cancel a running backup', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /id="backup-cancel"[^>]*hidden/);
  assert.match(explorer, /method: "DELETE"/);
  assert.match(
    explorer,
    /\/api\/backup\/jobs\/\$\{encodeURIComponent\(id\)\}/,
  );
  // Cancelling says what happened to the archive, using what the node reported.
  assert.match(explorer, /finished\.discarded/);
  assert.match(explorer, /Backup cancelled · discarded/);
  assert.match(explorer, /No archive|no archive was written/);
});

test('a stale automatic backup is warned about once per episode', async () => {
  const passphrase = 'stale backup passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const logs = [];
  const errors = [];
  // A controllable clock: writing a backup runs scrypt twice, so real elapsed
  // time would make the freshness window racy. Shifting the clock decides the
  // age without waiting for it.
  let clockOffset = 0;
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 0,
    maxAgeMs: 2000,
    watchdogMs: 20,
    now: () => new Date(Date.now() + clockOffset),
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const waitUntil = async (check, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const staleWarnings = () => errors.filter((line) => line.includes('past the'));

  try {
    assert.ok(
      await waitUntil(() => logs.some((line) => line.startsWith('backup written'))),
      'the first backup ran',
    );
    assert.equal(schedule.status().maxAgeMs, 2000);

    // Jump past the limit rather than waiting for it.
    clockOffset = 3000;
    assert.ok(await waitUntil(() => staleWarnings().length === 1), 'a stale archive is warned about');
    assert.match(
      staleWarnings()[0],
      /^warning: the last automatic backup is [\d.]+ ?(s|min|h) old, past the [\d.]+ ?(s|min|h) limit; automatic backups may have stopped$/,
    );

    // The watchdog ticks every 20 ms; the warning must not repeat per tick.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(staleWarnings().length, 1, 'warned once per stale episode');

    // A successful backup clears the episode...
    await schedule.runNow();
    const afterRefresh = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(errors.length, afterRefresh, 'no warning while the archive is fresh');

    // ...and a new episode warns again once it goes stale.
    clockOffset = 6000;
    assert.ok(
      await waitUntil(() => staleWarnings().length === 2),
      'the warning re-arms after a successful backup',
    );

    const persisted = loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    });
    assert.equal(persisted.maxAgeMs, 2000);
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backup age limit defaults to twice the interval and is validated', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase: 'unused for scheduling',
    intervalMs: 10 * 60_000,
    firstDelayMs: 10 * 60_000,
    log: () => {},
    logError: () => {},
  });
  try {
    assert.equal(schedule.status().maxAgeMs, 20 * 60_000);
  } finally {
    schedule.stop();
  }

  assert.throws(
    () =>
      startBackupSchedule({
        params: devnet,
        chainFile,
        walletFile,
        directory: path.join(dir, 'backups'),
        passphrase: 'unused for scheduling',
        maxAgeMs: 0,
        log: () => {},
        logError: () => {},
      }),
    /age limit/,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the explorer uses the configured backup age limit', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /backup\.maxAgeMs/);
  assert.match(explorer, /the limit is/);
});

test('the explorer links every retained backup archive for download', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /id="backup-archives"/);
  assert.match(explorer, /id="backup-archive-list"/);
  // One link per archive the node reported, addressed by its name, so this is
  // not limited to the verified newest one anymore.
  assert.match(
    explorer,
    /href="\/api\/backup\/archives\/\$\{encodeURIComponent\(name\)\}"/,
  );
  assert.match(explorer, /const archives = Array\.isArray\(backup\?\.archives\)/);
  assert.match(explorer, /renderArchives\(backup\)/);
  // The newest archive is marked inside the list rather than being the only
  // entry offered, and an empty list hides the whole block.
  assert.match(explorer, /archive-newest/);
  assert.match(explorer, /\$\("backup-archives"\)\.hidden = true/);
  assert.match(explorer, /formatNumber\(archive\.bytes\)/);
  // The digest and the exact byte count travel with the link, so a saved copy
  // can be checked without asking the node again.
  assert.match(explorer, /class="archive-sum\$\{sum \? "" : " pending"\}"/);
  assert.match(explorer, /const sum = typeof archive\.sha256 === "string"/);
  assert.match(explorer, /`sha256 \$\{sum\}`/);
  assert.match(explorer, /sha256 computing…/);
  assert.match(explorer, /verify with: sha256sum/);
  assert.match(explorer, /\$\{exactSize\}/);
});

test('the node lists every retained archive and serves any of them', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'archive list passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  const originalLog = console.log;
  console.log = () => {};
  let node = null;
  let bare = null;

  const listening = async (instance) => {
    const deadline = Date.now() + 3000;
    while (!instance.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${instance.server.address().port}`;
  };

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 10 * 60_000,
      },
    });
    const url = await listening(node);

    const newest = await node.backups.runNow();
    // Two older archives, as retention would have left them from earlier runs.
    // Stamps are derived from the real one so the test does not depend on the
    // clock it happens to run at.
    const stampMatch = path.basename(newest.path).match(
      /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})\.json\.gz$/,
    );
    assert.ok(stampMatch, 'the archive name carries a timestamp');
    const writtenAt = Date.UTC(
      Number(stampMatch[1]),
      Number(stampMatch[2]) - 1,
      Number(stampMatch[3]),
      Number(stampMatch[4]),
      Number(stampMatch[5]),
      Number(stampMatch[6]),
      Number(stampMatch[7]),
    );
    const older = [1, 2].map((hoursAgo) => {
      const digits = new Date(writtenAt - hoursAgo * 3_600_000)
        .toISOString()
        .replace(/\D/g, '')
        .slice(0, 17);
      const name = `doubloom-devnet-backup-${digits.slice(0, 8)}-${digits.slice(8)}.json.gz`;
      fs.copyFileSync(newest.path, path.join(backupDir, name));
      return name;
    });
    // A file retention would never touch must not become downloadable either.
    fs.writeFileSync(path.join(backupDir, 'chain.json'), '{"not":"an archive"}');

    const listed = await (await fetch(`${url}/api/backup`)).json();
    assert.equal(listed.enabled, true);
    assert.deepEqual(
      listed.archives.map((archive) => archive.name),
      // Newest first, so the one the schedule just wrote leads.
      [path.basename(newest.path), ...older],
    );
    for (const archive of listed.archives) {
      assert.ok(archive.bytes > 0, `${archive.name} has a size`);
      assert.match(archive.at, /^\d{4}-\d{2}-\d{2}T/);
    }

    // Each entry gains a SHA-256 an operator can compare their copy against.
    // The node reads the file in the background, so the first listing may still
    // report null; the next one carries it.
    const fileSum = (name) =>
      createHash('sha256')
        .update(fs.readFileSync(path.join(backupDir, name)))
        .digest('hex');
    let summed = listed;
    const sumDeadline = Date.now() + 5000;
    while (
      summed.archives.some((archive) => typeof archive.sha256 !== 'string') &&
      Date.now() < sumDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      summed = await (await fetch(`${url}/api/backup`)).json();
    }
    for (const archive of summed.archives) {
      assert.equal(archive.sha256, fileSum(archive.name), `${archive.name} digest`);
      assert.match(archive.sha256, /^[0-9a-f]{64}$/);
    }

    // A rewritten archive is re-hashed rather than reported with its old digest.
    fs.appendFileSync(path.join(backupDir, older[1]), 'extra');
    const rewritten = fileSum(older[1]);
    const rewriteDeadline = Date.now() + 5000;
    let updated = summed;
    while (Date.now() < rewriteDeadline) {
      updated = await (await fetch(`${url}/api/backup`)).json();
      const entry = updated.archives.find((archive) => archive.name === older[1]);
      if (entry?.sha256 === rewritten) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      updated.archives.find((archive) => archive.name === older[1]).sha256,
      rewritten,
      'the digest follows the file',
    );
    assert.ok(
      !listed.archives.some((archive) => archive.name === 'chain.json'),
      'unrelated files are not listed',
    );

    // Any listed archive downloads, not just the newest.
    for (const name of older) {
      const response = await fetch(
        `${url}/api/backup/archives/${encodeURIComponent(name)}`,
      );
      assert.equal(response.status, 200, `${name} downloads`);
      assert.equal(response.headers.get('content-type'), 'application/gzip');
      assert.equal(
        response.headers.get('content-disposition'),
        `attachment; filename="${name}"`,
      );
      const body = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(
        body,
        fs.readFileSync(path.join(backupDir, name)),
        'the download is the archive on disk',
      );
    }

    // Names outside the archive pattern are refused, including traversal and
    // an unrelated file that really is in the directory.
    for (const name of ['chain.json', '..%2Fchain.json', 'missing.json.gz']) {
      const response = await fetch(`${url}/api/backup/archives/${name}`);
      assert.equal(response.status, 404, `${name} is refused`);
      assert.match((await response.json()).error, /no backup archive named/);
    }

    // A node without a backup directory says so instead of 404ing per name.
    bare = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'bare-chain.json'),
      port: 0,
    });
    const bareUrl = await listening(bare);
    const disabled = await fetch(
      `${bareUrl}/api/backup/archives/doubloom-devnet-backup-20261031-010000001.json.gz`,
    );
    assert.equal(disabled.status, 409);
    assert.match((await disabled.json()).error, /not enabled/);
    const bareStatus = await (await fetch(`${bareUrl}/api/backup`)).json();
    assert.equal(bareStatus.enabled, false);
    assert.deepEqual(bareStatus.archives, []);
  } finally {
    console.log = originalLog;
    await node?.close();
    await bare?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the node serves its latest verified backup archive for download', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'download backup passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  const originalLog = console.log;
  console.log = () => {};
  let node = null;
  let bare = null;

  const listening = async (instance) => {
    const deadline = Date.now() + 3000;
    while (!instance.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${instance.server.address().port}`;
  };

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 10 * 60_000,
        retention: { hourly: 3, daily: 0, weekly: 0 },
      },
    });
    const url = await listening(node);

    // No archive has been verified yet, so there is nothing to send.
    const empty = await fetch(`${url}/api/backup/download`);
    assert.equal(empty.status, 404);
    assert.match((await empty.json()).error, /no verified backup archive yet/);

    const result = await node.backups.runNow();
    const response = await fetch(`${url}/api/backup/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="${path.basename(result.path)}"`,
    );
    assert.equal(response.headers.get('content-length'), String(result.bytes));

    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, result.bytes);
    assert.deepEqual(
      body,
      fs.readFileSync(result.path),
      'the download is the archive on disk',
    );
    assert.deepEqual(
      fs.readdirSync(backupDir),
      [path.basename(result.path)],
      'downloading copies the archive rather than moving it',
    );

    // The archived chain still restores from what was downloaded.
    const downloaded = path.join(dir, 'downloaded.json.gz');
    fs.writeFileSync(downloaded, body);
    const restored = restoreNodeBackup({
      source: downloaded,
      params: devnet,
      chainFile: path.join(dir, 'restored', 'chain.json'),
      walletFile: path.join(dir, 'restored', 'wallet.json'),
      passphrase,
    });
    assert.equal(restored.height, chain.height);

    // If the archive is pruned while the status still names it, the endpoint
    // reports that rather than failing mid-stream.
    fs.rmSync(result.path);
    const pruned = await fetch(`${url}/api/backup/download`);
    assert.equal(pruned.status, 404);
    assert.match((await pruned.json()).error, /backup archive is missing/);

    // A node without a backup directory says so instead of serving a 404.
    bare = startNode({
      chain,
      params: devnet,
      chainFile: path.join(dir, 'bare-chain.json'),
      port: 0,
    });
    const bareUrl = await listening(bare);
    const disabled = await fetch(`${bareUrl}/api/backup/download`);
    assert.equal(disabled.status, 409);
    assert.match((await disabled.json()).error, /not enabled/);
  } finally {
    console.log = originalLog;
    await node?.close();
    await bare?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded archive outside the backup directory is never served', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'outside archive passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  const outside = path.join(dir, 'elsewhere', 'stolen.json.gz');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'not a backup');

  // A status file from a previous run can name any path; the endpoint must not
  // turn that into an arbitrary file read.
  fs.writeFileSync(
    backupStatusFile(chainFile),
    JSON.stringify({
      version: 1,
      network: devnet.name,
      pid: process.pid,
      directory: backupDir,
      intervalMs: 60_000,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      nextRunAt: null,
      lastBackup: {
        at: new Date().toISOString(),
        height: 1,
        path: outside,
        bytes: 12,
        keys: 1,
      },
    }),
  );

  const originalLog = console.log;
  console.log = () => {};
  let node = null;
  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 10 * 60_000,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const url = `http://127.0.0.1:${node.server.address().port}`;

    const refused = await fetch(`${url}/api/backup/download`);
    assert.equal(refused.status, 403);
    const body = await refused.text();
    assert.match(JSON.parse(body).error, /outside the backup directory/);
    assert.equal(
      body.includes('not a backup'),
      false,
      'the bytes of the outside file are never sent',
    );
  } finally {
    console.log = originalLog;
    await node?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the schedule reports and clears its next run time', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const backupDir = path.join(dir, 'backups');
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase: 'not used for scheduling',
    intervalMs: 60000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 60000,
    log: () => {},
    logError: () => {},
  });

  const status = schedule.status();
  assert.equal(status.running, false);
  assert.equal(status.firstDelayMs, 60000);
  assert.ok(status.nextRunAt, 'a next run time is reported');
  assert.ok(Date.parse(status.nextRunAt) > Date.now());
  assert.ok(Date.parse(status.nextRunAt) <= Date.now() + 60000);

  const persisted = loadBackupStatus({
    statusFile: backupStatusFile(chainFile),
    network: devnet.name,
  });
  assert.equal(persisted.nextRunAt, status.nextRunAt);
  assert.equal(persisted.pid, process.pid);
  assert.equal(persisted.directory, backupDir);
  assert.equal(persisted.firstDelayMs, 60000);
  assert.equal(persisted.intervalMs, 60000);
  assert.equal(persisted.retention.hourly, 2);

  schedule.stop();
  assert.equal(schedule.status().nextRunAt, null, 'stop clears the next run time');
  assert.equal(
    loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    }).nextRunAt,
    null,
    'the cleared time is persisted',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the backup watchdog leaves a healthy schedule alone', async () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const logs = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase: 'not used for scheduling',
    intervalMs: 60000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    firstDelayMs: 60000,
    watchdogMs: 15,
    log: (message) => logs.push(message),
    logError: () => {},
  });

  const before = schedule.status().nextRunAt;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(schedule.status().nextRunAt, before);
  assert.equal(schedule.ensureScheduled(), false);
  assert.deepEqual(logs, [], 'an armed schedule is not re-armed');

  schedule.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup recovery catches up an overdue archive', () => {
  const nowMs = Date.parse('2026-10-30T00:00:00.000Z');
  const delay = (overrides) =>
    backupRecoveryDelayMs({
      nowMs,
      lastBackupAt: new Date(nowMs - 30_000).toISOString(),
      intervalMs: 60_000,
      firstDelayMs: 10_000,
      firstBackupPending: false,
      ...overrides,
    });

  assert.equal(delay({}), 30_000, 'an on-time archive keeps its cadence');
  assert.equal(
    delay({ lastBackupAt: new Date(nowMs - 120_000).toISOString() }),
    0,
    'an overdue archive runs immediately',
  );
  assert.equal(
    delay({ lastBackupAt: null }),
    0,
    'a missing archive is caught up immediately',
  );
  assert.equal(
    delay({
      lastBackupAt: new Date(nowMs - 120_000).toISOString(),
      firstBackupPending: true,
    }),
    10_000,
    'the first backup keeps its configured delay',
  );
});

test('the backup watchdog re-arms a schedule that lost its timer', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const logs = [];
  const realSetTimeout = globalThis.setTimeout;
  let schedule;
  try {
    // A timer factory that returns nothing leaves nextRunAt set but no timer,
    // which is the state the watchdog must repair.
    globalThis.setTimeout = () => null;
    schedule = startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile,
      directory: path.join(dir, 'backups'),
      passphrase: 'not used for scheduling',
      intervalMs: 60000,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      firstDelayMs: 60000,
      watchdogMs: 15,
      log: (message) => logs.push(message),
      logError: () => {},
    });

    assert.ok(schedule.status().nextRunAt);
    assert.equal(schedule.ensureScheduled(), true);
    assert.match(logs[0], /timer was missing/);
    assert.ok(schedule.status().nextRunAt, 'a new run is scheduled');

    const recovery = schedule.status().lastRecovery;
    assert.match(recovery.reason, /timer was missing/);
    assert.ok(Number.isFinite(Date.parse(recovery.at)));
    assert.deepEqual(schedule.status().recoveryHistory, [recovery]);

    for (let index = 0; index < 5; index += 1) {
      assert.equal(schedule.ensureScheduled(), true);
    }
    const history = schedule.status().recoveryHistory;
    assert.equal(history.length, 5, 'only the five newest recoveries are kept');
    assert.deepEqual(history[0], schedule.status().lastRecovery);

    const persisted = loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    });
    assert.deepEqual(persisted.lastRecovery, history[0]);
    assert.deepEqual(persisted.recoveryHistory, history, 'the history is persisted');
    assert.equal(persisted.recoveryHistoryLimit, 5);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    schedule?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a single recovery in an older status file becomes a history entry', () => {
  const { dir, chainFile } = temporaryNode();
  const statusFile = backupStatusFile(chainFile);
  const recovery = {
    at: '2026-10-30T06:05:41.922Z',
    reason: 'timer was missing',
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ version: 1, network: devnet.name, lastRecovery: recovery }),
  );

  const loaded = loadBackupStatus({
    statusFile,
    network: devnet.name,
  });
  assert.deepEqual(loaded.recoveryHistory, [recovery]);
  assert.deepEqual(loaded.lastRecovery, recovery);
  assert.equal(loaded.recoveryHistoryLimit, 5, 'older files use the default depth');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the recovery history depth is configurable', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const realSetTimeout = globalThis.setTimeout;
  let schedule;
  try {
    globalThis.setTimeout = () => null;
    schedule = startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile,
      directory: path.join(dir, 'backups'),
      passphrase: 'not used for scheduling',
      intervalMs: 60000,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      firstDelayMs: 60000,
      recoveryHistoryLimit: 2,
      watchdogMs: 15,
      log: () => {},
      logError: () => {},
    });

    for (let index = 0; index < 3; index += 1) {
      assert.equal(schedule.ensureScheduled(), true);
    }
    const status = schedule.status();
    assert.equal(status.recoveryHistoryLimit, 2);
    assert.equal(status.recoveryHistory.length, 2);
    assert.deepEqual(status.recoveryHistory[0], status.lastRecovery);

    const persisted = loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    });
    assert.equal(persisted.recoveryHistoryLimit, 2);
    assert.deepEqual(persisted.recoveryHistory, status.recoveryHistory);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    schedule?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovered schedule catches up an overdue archive immediately', () => {
  const { dir, chainFile } = temporaryNode();
  const backupDir = path.join(dir, 'backups');
  const statusFile = backupStatusFile(chainFile);
  const oldArchive = new Date(Date.now() - 120_000).toISOString();
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      version: 1,
      network: devnet.name,
      pid: process.pid,
      directory: backupDir,
      firstDelayMs: 60000,
      intervalMs: 60000,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      nextRunAt: null,
      waitingForSync: false,
      lastAttemptAt: oldArchive,
      lastError: null,
      lastBackup: {
        at: oldArchive,
        height: 1,
        path: path.join(backupDir, 'old-backup.json'),
        bytes: 1,
      },
    }),
  );

  const logs = [];
  const callbacks = [];
  const realSetTimeout = globalThis.setTimeout;
  let schedule;
  try {
    globalThis.setTimeout = (callback) => {
      callbacks.push(callback);
      return null;
    };
    schedule = startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile: path.join(dir, 'missing-wallet.json'),
      directory: backupDir,
      passphrase: 'not used for a failing backup',
      intervalMs: 60000,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      firstDelayMs: 60000,
      watchdogMs: 15,
      log: (message) => logs.push(message),
      logError: () => {},
    });

    callbacks.shift()();
    assert.equal(schedule.status().lastBackup.at, oldArchive);
    assert.equal(schedule.ensureScheduled(), true);
    assert.match(logs.join('\n'), /archive overdue, catching up now/);
    assert.ok(
      Date.parse(schedule.status().nextRunAt) <= Date.now() + 1000,
      'the recovered run is due immediately',
    );
    assert.match(
      schedule.status().lastRecovery.reason,
      /timer was missing; archive overdue, catching up now/,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    schedule?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the first backup waits for readiness before running', async () => {
  const passphrase = 'readiness backup passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  let ready = false;
  const logs = [];
  const errors = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    firstDelayMs: 0,
    firstReady: () => ready,
    readyPollMs: 20,
    intervalMs: 60000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const waitingDeadline = Date.now() + 3000;
  while (!schedule.status().waitingForSync && Date.now() < waitingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(schedule.status().waitingForSync, true);
  assert.equal(fs.readdirSync(backupDir).length, 0, 'no archive before readiness');
  assert.equal(logs.length, 0);

  ready = true;
  const backupDeadline = Date.now() + 5000;
  while (logs.length === 0 && Date.now() < backupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(logs.length, 1, 'one backup after readiness');
  assert.equal(errors.length, 0);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal(schedule.status().waitingForSync, false);

  schedule.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the first backup stops waiting for peer sync at the configured cap', async () => {
  const passphrase = 'sync cap passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  const logs = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    firstDelayMs: 0,
    firstMaxWaitMs: 1500,
    firstReady: () => false,
    readyPollMs: 20,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    log: (message) => logs.push(message),
    logError: () => {},
  });

  try {
    // Within the cap the behaviour is unchanged: it waits, archive-less.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(schedule.status().waitingForSync, true);
    assert.equal(fs.readdirSync(backupDir).length, 0, 'no archive while waiting');

    // The wait is reported as a measurement, not just a state: a client needs
    // the start time and the length so far to show how long it has been going.
    const waiting = schedule.status();
    assert.ok(
      Number.isFinite(Date.parse(waiting.syncWaitStartedAt)),
      'a waiting schedule reports when the wait began',
    );
    assert.ok(
      waiting.syncWaitedMs > 0 && waiting.syncWaitedMs < 1500,
      `elapsed wait is measured (${waiting.syncWaitedMs}ms)`,
    );

    const deadline = Date.now() + 5000;
    while (fs.readdirSync(backupDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // A peer that never settles now costs a late archive instead of none.
    assert.equal(fs.readdirSync(backupDir).length, 1, 'an archive despite no sync');
    assert.equal(schedule.status().waitingForSync, false);
    // Once the waiting is over there is no measurement to report, so a client
    // cannot show a wait that has ended.
    assert.equal(schedule.status().syncWaitedMs, null);
    assert.equal(schedule.status().syncWaitStartedAt, null);
    assert.match(
      logs.join('\n'),
      /peer sync has not settled after [\d.]+s \(limit 1\.5s\); writing an archive anyway/,
      'the give-up is explained in the log',
    );

    // The cap is part of the record, so status output and the explorer can
    // report the setting rather than leaving it a hidden default.
    assert.equal(schedule.status().firstMaxWaitMs, 1500);
    const persisted = JSON.parse(
      fs.readFileSync(backupStatusFile(chainFile), 'utf8'),
    );
    assert.equal(persisted.firstMaxWaitMs, 1500);
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a zero first-backup wait cap keeps waiting for peer sync', async () => {
  const passphrase = 'uncapped sync passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const backupDir = path.join(dir, 'backups');
  let ready = false;
  const logs = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    firstDelayMs: 0,
    firstMaxWaitMs: 0,
    firstReady: () => ready,
    readyPollMs: 20,
    intervalMs: 60_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    log: (message) => logs.push(message),
    logError: () => {},
  });

  try {
    // 0 is the opt-out, so a node that must not snapshot a partial chain keeps
    // waiting however long the peer takes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fs.readdirSync(backupDir).length, 0, 'still no archive');
    assert.equal(schedule.status().waitingForSync, true);

    ready = true;
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(backupDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.readdirSync(backupDir).length, 1);
    assert.equal(schedule.status().waitingForSync, false);
    assert.ok(
      !logs.join('\n').includes('writing an archive anyway'),
      'no give-up with the cap switched off',
    );
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the block-lag limit defaults, persists and rejects nonsense', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  const statusFile = backupStatusFile(chainFile);
  const open = (overrides = {}) =>
    startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile,
      directory: path.join(dir, 'backups'),
      passphrase: 'not used for scheduling',
      intervalMs: 60_000,
      firstDelayMs: 60_000,
      log: () => {},
      logError: () => {},
      ...overrides,
    });

  let schedule = open();
  try {
    // The default is one interval's worth of blocks, so a faster schedule is
    // judged proportionally: six at Bitcoin's ten-minute spacing, sixty on a
    // network whose blocks come every minute.
    assert.equal(defaultMaxLagBlocks(networkParams('mainnet'), 3_600_000), 6);
    assert.equal(defaultMaxLagBlocks(devnet, 3_600_000), 60);
    assert.equal(defaultMaxLagBlocks(devnet, 600_000), 10);
    // An interval shorter than one block still gets a limit of one, never zero.
    assert.equal(defaultMaxLagBlocks(devnet, 1_000), 1);
    assert.equal(defaultMaxLagBlocks(undefined, 3_600_000), 1);

    schedule = open({ intervalMs: 10 * 60_000 });
    assert.equal(schedule.status().maxLagBlocks, 10);
    schedule.stop();

    schedule = open({ maxLagBlocks: 2 });
    assert.equal(schedule.status().maxLagBlocks, 2);
    // Persisted, so `backup status` reports the limit of the node that wrote the
    // schedule even after it exits.
    assert.equal(
      loadBackupStatus({ statusFile, network: devnet.name }).maxLagBlocks,
      2,
    );
    schedule.stop();

    // A file from a node that predates the setting has no figure to report.
    const older = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    delete older.maxLagBlocks;
    fs.writeFileSync(statusFile, JSON.stringify(older));
    assert.equal(
      loadBackupStatus({ statusFile, network: devnet.name }).maxLagBlocks,
      null,
    );

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => open({ maxLagBlocks: bad }),
        /backup lag limit must be a positive number of blocks/,
      );
    }
  } finally {
    schedule?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archive write times are recorded and outrank the file mtime', async () => {
  const passphrase = 'write times passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupDir = path.join(dir, 'backups');
  const statusFile = backupStatusFile(chainFile);
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase,
    intervalMs: 3_600_000,
    firstDelayMs: 3_600_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    log: () => {},
    logError: () => {},
  });

  try {
    const first = await schedule.runNow();
    const firstName = path.basename(first.path);
    let persisted = loadBackupStatus({ statusFile, network: devnet.name });
    const record = persisted.archiveWrites[firstName];
    assert.ok(record, 'the write is recorded by archive name');
    // The attempt is the time the run started, which is also what the archive
    // is dated by; the finish is the file's last write.
    assert.equal(record.startedAt, persisted.lastBackup.at);
    assert.ok(
      Date.parse(record.finishedAt) >= Date.parse(record.startedAt),
      'the finish follows the attempt',
    );
    const recordedMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);

    // Moving the mtime changes nothing once the write is recorded: a copy or a
    // restore can move it, the run itself cannot.
    fs.utimesSync(
      first.path,
      new Date(),
      new Date(Date.parse(record.finishedAt) + 10_000),
    );
    const withRecord = listArchives({
      directory: backupDir,
      network: devnet.name,
      writes: persisted.archiveWrites,
    });
    assert.equal(withRecord[0].writeMs, Math.round(recordedMs));
    assert.equal(withRecord[0].startedAt, record.startedAt);
    assert.equal(withRecord[0].finishedAt, record.finishedAt);
    // Without the record the mtime is all there is, which is the fallback.
    const fallback = listArchives({ directory: backupDir, network: devnet.name });
    assert.ok(
      fallback[0].writeMs >= Math.round(recordedMs) + 9_000,
      'the fallback follows the shifted mtime',
    );

    // Retention keeps one archive per hour, so the second run prunes the first —
    // and its record goes with it rather than describing a file that is gone.
    const second = await schedule.runNow();
    persisted = loadBackupStatus({ statusFile, network: devnet.name });
    assert.equal(persisted.archiveWrites[firstName], undefined);
    assert.ok(persisted.archiveWrites[path.basename(second.path)]);
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the schedule warns when the newest archive falls behind the tip', async () => {
  const passphrase = 'lag warning passphrase';
  const { dir, chainFile, walletFile, wallet, chain } = temporaryNode();
  wallet.encrypt(passphrase);
  const logs = [];
  const errors = [];
  let tip = chain.height;
  let clockOffset = 0;
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 3_600_000,
    firstDelayMs: 0,
    maxAgeMs: 1_200_000,
    maxLagBlocks: 2,
    watchdogMs: 15,
    // The scheduler has no chain, so the tip comes from its owner.
    tipHeight: () => tip,
    now: () => new Date(Date.now() + clockOffset),
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const waitUntil = async (check, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const lagWarnings = () =>
    errors.filter((line) =>
      line.startsWith('warning: the newest automatic backup is'),
    );

  try {
    assert.ok(
      await waitUntil(() => logs.some((line) => line.startsWith('backup written'))),
      'the first backup ran',
    );
    const archived = schedule.status().lastBackup.height;

    // At the limit is still fine; nothing is said about two blocks.
    tip = archived + 2;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(lagWarnings().length, 0);

    // Past it, the warning names the gap and the configured limit, once.
    tip = archived + 3;
    assert.ok(await waitUntil(() => lagWarnings().length > 0), 'the lag warning appeared');
    assert.match(
      lagWarnings()[0],
      /^warning: the newest automatic backup is 3 blocks behind the tip \(limit 2\); it is within the age limit but no longer represents the chain$/,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(lagWarnings().length, 1, 'one warning per episode');

    // Back within the limit, the all-clear says where it stands.
    tip = archived + 1;
    assert.ok(
      await waitUntil(() => logs.some((line) => line.startsWith('backup lag cleared'))),
      'the all-clear was logged',
    );
    assert.match(
      logs.find((line) => line.startsWith('backup lag cleared')),
      /is 1 block behind the tip, within the 2 blocks limit$/,
    );

    // A stale archive is the age warning's business: it already says the
    // schedule stopped, so the gap is not reported again on top of it.
    clockOffset = 40 * 60_000;
    tip = archived + 10;
    assert.ok(
      await waitUntil(() => errors.some((line) => line.includes('past the'))),
      'the age warning appeared',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(lagWarnings().length, 1, 'no lag warning beside the age warning');
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that replaces a lagging archive logs a recovery', async () => {
  const passphrase = 'lag recovery passphrase';
  const { dir, chainFile, walletFile, wallet, chain } = temporaryNode();
  wallet.encrypt(passphrase);
  const logs = [];
  const errors = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 3_600_000,
    firstDelayMs: 0,
    maxAgeMs: 1_200_000,
    maxLagBlocks: 2,
    watchdogMs: 15,
    tipHeight: () => chain.height,
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  const waitUntil = async (check, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  try {
    // The zero first delay means the schedule writes its own first archive; a
    // manual run before that leaves the readiness gate closed.
    assert.ok(
      await waitUntil(() => logs.some((line) => line.startsWith('backup written'))),
      'the first backup ran',
    );
    // Grow the chain past the limit, so the archive on disk is left behind.
    for (let index = 0; index < 3; index += 1) {
      const block = chain.buildBlock(wallet.defaultKey().address);
      mineHeader(block.header);
      chain.addBlock(block);
    }
    // The schedule backs up the chain file, so the new tip has to be on disk.
    saveChain(chain, chainFile);
    assert.ok(
      await waitUntil(() =>
        errors.some((line) => line.includes('behind the tip (limit 2)')),
      ),
      'the warning came first',
    );

    // The run that replaces it ends the episode and says so, in the same shape
    // as an archive that had merely gone old.
    const fresh = await schedule.runNow();
    const recovered = logs.find((line) =>
      line.startsWith('backup schedule recovered:'),
    );
    assert.ok(recovered, `expected a recovery line, got: ${logs.join(' | ')}`);
    assert.match(
      recovered,
      /^backup schedule recovered: the previous archive was 3 blocks behind the tip \(limit 2\); fresh archives are being written again \(height \d+\)$/,
    );
    assert.equal(fresh.height, chain.height);

    // The same sentence is in the persisted history, so it survives a restart.
    const status = schedule.status();
    assert.equal(status.recoveryHistory.length, 1);
    assert.equal(
      status.recoveryHistory[0].reason,
      recovered.replace('backup schedule recovered: ', ''),
    );
    const persisted = loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    });
    assert.deepEqual(persisted.recoveryHistory, status.recoveryHistory);

    // The recovery replaces the bare all-clear, and the warning is not repeated
    // now that the archive is back at the tip.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      logs.filter((line) => line.startsWith('backup lag cleared')).length,
      0,
      'the recovery line is the all-clear for this episode',
    );
    assert.equal(
      errors.filter((line) =>
        line.startsWith('warning: the newest automatic backup is'),
      ).length,
      1,
      'one warning for the episode',
    );
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node warns in its log when its archive falls behind the tip', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'node lag passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  console.error = (...args) => {
    errors.push(args.join(' '));
  };
  let node = null;

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: path.join(dir, 'backups'),
        passphrase,
        intervalMs: 3_600_000,
        firstDelayMs: 0,
        maxLagBlocks: 2,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 5000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while (
      !logs.some((line) => line.startsWith('backup written')) &&
      Date.now() < deadline + 5000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Mine past the limit without waiting for the next scheduled run.
    for (let index = 0; index < 3; index += 1) {
      const block = chain.buildBlock(wallet.defaultKey().address);
      mineHeader(block.header);
      chain.addBlock(block);
    }

    // The node's watchdog runs every ten seconds, so allow it one pass.
    const warned = Date.now() + 15_000;
    while (
      !errors.some((line) => line.includes('behind the tip')) &&
      Date.now() < warned
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      errors.some((line) =>
        line.includes('behind the tip (limit 2); it is within the age limit'),
      ),
      `expected a lag warning, got: ${errors.join(' | ')}`,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (node) {
      await node.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the node rejects a bad block-lag limit', async () => {
  const passphrase = 'lag flag passphrase';
  const { dir, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        path.join(dir, 'data'),
        'node',
        '--backup-dir',
        path.join(dir, 'backups'),
        ...args,
      ],
      {
        timeout: 20_000,
        env: { ...process.env, DOUBLOOM_PASSPHRASE: passphrase },
      },
    );

  try {
    await assert.rejects(
      run('--backup-max-lag', '0'),
      /--backup-max-lag must be a positive whole number of blocks/,
    );
    await assert.rejects(
      run('--backup-max-lag', '2.5'),
      /--backup-max-lag must be a positive whole number of blocks/,
    );
    await assert.rejects(
      run('--backup-max-lag'),
      /--backup-max-lag requires a number of blocks/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the configured lag limit reaches the startup log and backup status', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'lag report passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  let node = null;

  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dataDir, ...args],
      { timeout: 20_000 },
    ).then((result) => result.stdout.replace(/\u001b\[[0-9;]*m/g, ''));

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: path.join(dir, 'backups'),
        passphrase,
        intervalMs: 600_000,
        firstDelayMs: 60_000,
        // Two blocks: a stricter limit than the default six.
        maxLagBlocks: 2,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The startup line lists it beside the age limit it belongs with.
    assert.match(
      logs.join('\n'),
      /Automatic backups: .*max age 20 min, lag 2 blocks/,
    );

    console.log = () => {};
    const text = await run('backup', 'status');
    assert.match(
      text,
      /schedule\s+every 10 min · keep hourly 2 · recoveries 5 · max age 20 min · lag 2 blocks/,
    );

    // And the script-friendly record carries the number, not the sentence.
    const payload = JSON.parse(await run('backup', 'status', '--json'));
    assert.equal(payload.maxLagBlocks, 2);
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a negative first-backup wait cap is rejected', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  assert.throws(
    () =>
      startBackupSchedule({
        params: devnet,
        chainFile,
        walletFile,
        directory: path.join(dir, 'backups'),
        passphrase: 'not used for scheduling',
        firstMaxWaitMs: -1,
      }),
    /first backup wait limit/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the node rejects a bad first-backup wait cap', async () => {
  const passphrase = 'cap flag passphrase';
  const { dir, wallet } = temporaryNode();
  // The node checks the wallet before it parses these flags, so the wallet has
  // to be usable before a bad cap can be reported.
  wallet.encrypt(passphrase);
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        path.join(dir, 'data'),
        'node',
        '--backup-dir',
        path.join(dir, 'backups'),
        ...args,
      ],
      {
        timeout: 20_000,
        env: { ...process.env, DOUBLOOM_PASSPHRASE: passphrase },
      },
    );

  try {
    await assert.rejects(
      run('--backup-first-max-wait', 'soon'),
      /--backup-first-max-wait must be zero or more seconds/,
    );
    await assert.rejects(
      run('--backup-first-max-wait'),
      /--backup-first-max-wait requires a number of seconds/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a negative first backup delay is rejected', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  assert.throws(
    () =>
      startBackupSchedule({
        params: devnet,
        chainFile,
        walletFile,
        directory: path.join(dir, 'backups'),
        passphrase: 'not used for scheduling',
        firstDelayMs: -1,
      }),
    /first backup delay/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a recovery history depth below one is rejected', () => {
  const { dir, chainFile, walletFile } = temporaryNode();
  assert.throws(
    () =>
      startBackupSchedule({
        params: devnet,
        chainFile,
        walletFile,
        directory: path.join(dir, 'backups'),
        passphrase: 'not used for scheduling',
        recoveryHistoryLimit: 0,
      }),
    /recovery history depth/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed automatic backup is logged and does not stop the schedule', async () => {
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt('right automatic passphrase');

  const backupDir = path.join(dir, 'backups');
  const errors = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: backupDir,
    passphrase: 'wrong automatic passphrase',
    intervalMs: 30,
    retention: { hourly: 1, daily: 0, weekly: 0 },
    firstDelayMs: 0,
    log: () => {},
    logError: (message) => errors.push(message),
  });

  const deadline = Date.now() + 5000;
  while (errors.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  schedule.stop();

  assert.ok(errors.length >= 2, 'the failing schedule kept retrying');
  assert.match(errors[0], /wrong passphrase/);
  assert.equal(fs.readdirSync(backupDir).length, 0);

  const status = schedule.status();
  assert.match(status.lastError, /wrong passphrase/);
  assert.equal(status.lastBackup, null);
  const persisted = loadBackupStatus({
    statusFile: backupStatusFile(chainFile),
    network: devnet.name,
  });
  assert.match(persisted.lastError, /wrong passphrase/);
  assert.throws(() => schedule.runNow(), /stopped/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('short or empty passphrases are rejected without changing the wallet', () => {
  const { file, wallet } = temporaryWallet();
  assert.throws(() => wallet.encrypt('short'), /at least 8 characters/);
  assert.throws(() => wallet.encrypt(''), /must not be empty/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('seed entries are parsed into a host and port', () => {
  assert.deepEqual(parseSeed('seed.example.org', 8338), {
    host: 'seed.example.org',
    port: 8338,
  });
  assert.deepEqual(parseSeed('seed.example.org:18400', 8338), {
    host: 'seed.example.org',
    port: 18400,
  });
  assert.deepEqual(parseSeed('http://seed.example.org:18400/', 8338), {
    host: 'seed.example.org',
    port: 18400,
  });
  assert.deepEqual(parseSeed('[::1]:18400', 8338), { host: '::1', port: 18400 });
  assert.equal(parseSeed('seed.example.org:0', 8338), null);
  assert.equal(parseSeed('seed.example.org:70000', 8338), null);
  assert.equal(parseSeed('http://', 8338), null);
  assert.equal(parseSeed('  ', 8338), null);
  assert.equal(parseSeed(undefined, 8338), null);
});

test('DNS seeds resolve into peer URLs and surviving seed failures are reported', async () => {
  const looked = [];
  const result = await discoverSeedPeers({
    seeds: [
      'seed-a.example:18400',
      'http://seed-b.example',
      'seed-c.example',
      'not a host',
    ],
    defaultPort: 8338,
    lookup: async (host) => {
      looked.push(host);
      if (host === 'seed-a.example') {
        return [
          { address: '127.0.0.1', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ];
      }
      if (host === 'seed-b.example') {
        return [{ address: '2001:db8::1', family: 6 }];
      }
      const error = new Error('getaddrinfo ENOTFOUND');
      error.code = 'ENOTFOUND';
      throw error;
    },
  });

  assert.deepEqual(result.peers, [
    'http://127.0.0.1:18400',
    'http://10.0.0.5:18400',
    'http://[2001:db8::1]:8338',
  ]);
  assert.deepEqual(result.resolved, ['seed-a.example', 'seed-b.example']);
  assert.deepEqual(result.errors, [
    { seed: 'seed-c.example', error: 'ENOTFOUND' },
    { seed: 'not a host', error: 'not a usable host' },
  ]);
  assert.deepEqual(looked, ['seed-a.example', 'seed-b.example', 'seed-c.example']);
});

test('a seed that never answers does not hold up discovery', async () => {
  const result = await discoverSeedPeers({
    seeds: ['slow.example', 'fast.example'],
    defaultPort: 8338,
    timeoutMs: 20,
    lookup: (host) =>
      host === 'slow.example'
        ? new Promise(() => {})
        : Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
  });

  assert.deepEqual(result.peers, ['http://127.0.0.1:8338']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /timed out/);
});

test('a node with DNS seeds adds the resolved peers automatically', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-seeds-'));
  const chainFile = path.join(dir, 'chain.json');
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const chain = Chain.create(devnet);
  const node = startNode({
    chain,
    params: devnet,
    chainFile,
    host: '127.0.0.1',
    port: 0,
    seeds: ['seed.example:18400'],
    seedLookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  try {
    const deadline = Date.now() + 3000;
    while (node.peers.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.deepEqual([...node.peers], ['http://127.0.0.1:18400']);
    assert.ok(
      logs.some((line) => line.includes('DNS seeds: seed.example:18400')),
      'the startup log names the configured seed',
    );
    assert.ok(
      logs.some((line) => line.includes('DNS seed discovery: 1 new peer')),
      'the discovery result is logged',
    );

    const { port } = node.server.address();
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(info.seeds, 1);
    assert.equal(info.work, chain.work.toString());
    assert.equal(info.pid, process.pid, 'the API names the process answering');
    assert.match(info.work, /^\d+$/);
    assert.equal(info.discovery.added, 1);
    assert.deepEqual(info.discovery.resolved, ['seed.example']);
    assert.deepEqual(info.discovery.errors, []);
  } finally {
    await node.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node logs the transactions it accepts and relays, but not echoes', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-tx-log-'));
  const funded = fundedChain();
  const payment = funded.wallet.buildTransaction(funded.chain, {
    to: funded.recipient.address,
    amount: 5n * COIN,
    feeRate: 1,
  });

  // Two nodes on the same chain, B known to A, so a transaction A accepts is
  // both logged and relayed while B logs only that it received it.
  const chainA = new Chain(devnet, JSON.parse(JSON.stringify(funded.chain.blocks)));
  const chainB = new Chain(devnet, JSON.parse(JSON.stringify(funded.chain.blocks)));

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const nodeA = startNode({
    chain: chainA,
    params: devnet,
    chainFile: path.join(dir, 'a.json'),
    port: 0,
  });
  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
  });

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  const post = async (url, body) => {
    const response = await fetch(`${url}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const aUrl = await listening(nodeA);
    const bUrl = await listening(nodeB);
    await fetch(`${aUrl}/api/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: bUrl }),
    });

    const accepted = await post(aUrl, payment.transaction);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.txid, payment.txid);

    // The accepting node names the sender, the shape, the fee, the size and the
    // fee rate, so a line shows what the transaction cost and how efficiently it
    // bought its space. The rate is the mempool's own figure, not a second
    // calculation that could drift from the one `doubloom mempool` prints.
    const mempool = await (await fetch(`${aUrl}/api/mempool`)).json();
    const entry = mempool.transactions.find((tx) => tx.txid === payment.txid);
    assert.ok(entry, 'the transaction is in the mempool');
    assert.equal(entry.size, accepted.body.size);
    const received =
      `received tx ${payment.txid} from 127.0.0.1 ` +
      `(${payment.transaction.inputs.length} in, ${payment.transaction.outputs.length} out, ` +
      `${accepted.body.fee} DBL fee, ${accepted.body.size} bytes, ` +
      `${entry.feeRate.toFixed(2)} petal/byte)`;
    assert.ok(logs.includes(received), `expected log line: ${received}`);

    // Relaying is logged only for a peer that took it, and only after it did.
    const relayed = `relayed tx ${payment.txid} to 1 peer`;
    const relayDeadline = Date.now() + 3000;
    while (!logs.includes(relayed) && Date.now() < relayDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(logs.includes(relayed), 'the relay is logged against the peer count');
    assert.equal((await (await fetch(`${bUrl}/api/mempool`)).json()).count, 1);
    assert.ok(
      logs.some(
        (line) =>
          line.startsWith(`received tx ${payment.txid} from 127.0.0.1`),
      ),
      'the peer that took the relay logs its own receipt',
    );

    // A duplicate is rejected, so neither node logs or relays it again.
    const receivedBefore = logs.filter((line) =>
      line.startsWith(`received tx ${payment.txid}`),
    ).length;
    const relayedBefore = logs.filter((line) => line.includes(`tx ${payment.txid}`)).length;
    assert.equal((await post(aUrl, payment.transaction)).status, 400);
    assert.equal((await post(bUrl, payment.transaction)).status, 400);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      logs.filter((line) => line.startsWith(`received tx ${payment.txid}`)).length,
      receivedBefore,
      'an echo is not logged as a fresh transaction',
    );
    assert.equal(
      logs.filter((line) => line.includes(`tx ${payment.txid}`)).length,
      relayedBefore,
      'an echo is not relayed again',
    );
  } finally {
    await nodeA.close();
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('log level "blocks" keeps block events and drops transaction lines', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-log-level-'));
  const funded = fundedChain();
  const chain = new Chain(
    devnet,
    JSON.parse(JSON.stringify(funded.chain.blocks)),
  );

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  let node = null;
  const listening = async (instance) => {
    const deadline = Date.now() + 3000;
    while (!instance.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${instance.server.address().port}`;
  };

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile: path.join(dir, 'chain.json'),
      port: 0,
      logLevel: 'blocks',
    });
    const url = await listening(node);

    const payment = funded.wallet.buildTransaction(chain, {
      to: funded.recipient.address,
      amount: 5n * COIN,
      feeRate: 1,
    });
    const accepted = await fetch(`${url}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payment.transaction),
    });
    assert.equal(accepted.status, 200);

    const block = chain.buildBlock(funded.miner.address);
    mineHeader(block.header);
    const pushed = await fetch(`${url}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(block),
    });
    assert.equal(pushed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const txLines = logs.filter(
      (line) =>
        line.startsWith('received tx') || line.startsWith('relayed tx'),
    );
    assert.deepEqual(
      txLines,
      [],
      `no transaction lines at this level: ${txLines.join(' | ')}`,
    );
    // The block events are exactly what must survive.
    assert.ok(logs.some((line) => line.startsWith('received block')));
    // Quiet logging is not quiet behaviour: both were still accepted.
    assert.equal((await (await fetch(`${url}/api/mempool`)).json()).count, 0);
    assert.equal((await (await fetch(`${url}/api/info`)).json()).height, 102);
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown log level is rejected before the node starts', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-log-level-bad-'));
  try {
    assert.throws(
      () =>
        startNode({
          chain: Chain.create(devnet),
          params: devnet,
          chainFile: path.join(dir, 'chain.json'),
          port: 0,
          logLevel: 'verbose',
        }),
      /unknown log level "verbose"/,
    );
    // Nothing was written or bound before the refusal.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doubloom node passes --log-level through to the node', async () => {
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-log-level-cli-'));
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dir, ...args],
      { timeout: 20_000 },
    );
  try {
    await run('init');
    await assert.rejects(
      run('node', '--log-level', 'verbose', '--port', '0'),
      (error) => {
        assert.match(error.stderr, /unknown log level "verbose"/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pushed block that does not extend the tip triggers an immediate chain fetch', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-fork-sync-'));
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('a');
  const minerB = wallet.newKey('b');

  const ancestor = Chain.create(devnet);
  mineBlocks(ancestor, minerA.address, 110);
  const fork = () =>
    new Chain(devnet, JSON.parse(JSON.stringify(ancestor.blocks)));
  const chainA = fork();
  const chainB = fork();
  mineBlocks(chainA, minerA.address, 3);
  mineBlocks(chainB, minerB.address, 6);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
  });
  const nodeA = startNode({
    chain: chainA,
    params: devnet,
    chainFile: path.join(dir, 'a.json'),
    port: 0,
  });

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  try {
    const bUrl = await listening(nodeB);
    const aUrl = await listening(nodeA);
    await fetch(`${aUrl}/api/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: bUrl }),
    });

    const initialHeight = chainA.height;
    assert.equal(initialHeight, 113);

    const started = Date.now();
    const rejected = await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chainB.tip),
    });
    assert.equal(rejected.status, 400);

    let height = initialHeight;
    while (height !== chainB.height && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      height = (await (await fetch(`${aUrl}/api/info`)).json()).height;
    }
    const elapsed = Date.now() - started;

    assert.equal(height, chainB.height, 'the forked node adopted the heavier chain');
    assert.ok(elapsed < 5000, `converged in ${elapsed}ms without waiting for the 20s sync`);
    // The push came from the peer's own address, so the node can tell which peer
    // sent it and names that peer: the fetch is aimed, not a fan-out.
    assert.ok(
      logs.some((line) =>
        line.includes(
          `does not extend our tip; requesting the chain from ${bUrl}`,
        ),
      ),
      'the rejection is logged against the peer that sent the block',
    );
    // The wait from that rejection to the switch is reported, so convergence
    // can be read off the log instead of timed by hand.
    const settled = logs.find((line) => line.includes('ms after rejecting block'));
    assert.ok(settled, 'the time to the heavier chain is logged');
    const settledMs = Number(settled.match(/(\d+) ms after rejecting/)[1]);
    assert.ok(
      settledMs <= elapsed,
      `logged ${settledMs}ms, the test saw the new tip at ${elapsed}ms`,
    );

    // A peer echoing a block we already have must not ask for the chain again.
    const before = logs.filter((line) =>
      line.includes('requesting the chain from'),
    ).length;
    const duplicate = await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chainB.tip),
    });
    assert.equal(duplicate.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = logs.filter((line) => line.includes('requesting the chain from'))
      .length;
    assert.equal(after, before, 'a duplicate block does not trigger a fetch');
  } finally {
    await nodeA.close();
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected push asks the peer that sent the block, not every peer', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-sender-first-'));
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('a');
  const minerB = wallet.newKey('b');
  const minerC = wallet.newKey('c');

  const ancestor = Chain.create(devnet);
  mineBlocks(ancestor, minerA.address, 110);
  const fork = () =>
    new Chain(devnet, JSON.parse(JSON.stringify(ancestor.blocks)));
  const chainA = fork();
  const chainB = fork();
  const chainC = fork();
  mineBlocks(chainA, minerA.address, 2);
  // B, the sender, is the heavier branch; C is a peer the pass should never
  // need once B has answered.
  mineBlocks(chainB, minerB.address, 6);
  mineBlocks(chainC, minerC.address, 4);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };
  const info = async (url) => (await fetch(`${url}/api/info`)).json();
  const requestsTo = (snapshot, peer) =>
    snapshot.peerTraffic.peers.find((entry) => entry.peer === peer)?.requests ??
    0;

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
    reachabilityDelayMs: 60_000,
  });
  const nodeC = startNode({
    chain: chainC,
    params: devnet,
    chainFile: path.join(dir, 'c.json'),
    port: 0,
    reachabilityDelayMs: 60_000,
  });
  let nodeA = null;

  try {
    const bUrl = await listening(nodeB);
    const cUrl = await listening(nodeC);
    // A starts with no peers: a start-up pass would adopt the heavier chain
    // before the push had a chance to ask for it.
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      reachabilityDelayMs: 60_000,
    });
    const aUrl = await listening(nodeA);
    await fetch(`${aUrl}/api/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peers: [bUrl, cUrl] }),
    });
    // Introducing a peer schedules a reachability probe; let it land so the
    // baselines below do not move under the assertion.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const before = await info(aUrl);
    assert.equal(before.height, chainA.height);
    const bBefore = requestsTo(before, bUrl);
    const cBefore = requestsTo(before, cUrl);

    // Pushed the way this node's own relays push: naming the sender.
    const rejected = await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-doubloom-from': bUrl,
      },
      body: JSON.stringify(chainB.tip),
    });
    assert.equal(rejected.status, 400);

    let current = before;
    const deadline = Date.now() + 5000;
    while (current.height !== chainB.height && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await info(aUrl);
    }
    assert.equal(
      current.height,
      chainB.height,
      'the sender chain was adopted without waiting for the periodic sync',
    );
    assert.ok(
      requestsTo(current, bUrl) > bBefore,
      'the peer that sent the block was asked for its chain',
    );
    // Both ends of the measurement are on the log: the rejection, then the
    // switch it led to, with the peer named in each.
    const settled = logs.find((line) => line.includes('ms after rejecting block'));
    assert.ok(settled, 'the time from rejection to the switch is logged');
    assert.ok(
      settled.includes(`from ${bUrl}`),
      `the timing names the peer that sent the block: ${settled}`,
    );
    assert.ok(
      Number(settled.match(/(\d+) ms after rejecting/)[1]) < 5000,
      'the switch happened promptly rather than on a later pass',
    );
    assert.equal(
      requestsTo(current, cUrl),
      cBefore,
      'the other peer was not queried once the sender resolved the fork',
    );
    assert.ok(
      logs.some((line) => line.includes(`requesting the chain from ${bUrl}`)),
      'the log names the peer the chain was fetched from',
    );
  } finally {
    await nodeA.close();
    await nodeB.close();
    await nodeC.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected push still asks the other peers when the sender has nothing new', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-sender-fallback-'));
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('a');
  const minerB = wallet.newKey('b');
  const minerC = wallet.newKey('c');

  const ancestor = Chain.create(devnet);
  mineBlocks(ancestor, minerA.address, 110);
  const fork = () =>
    new Chain(devnet, JSON.parse(JSON.stringify(ancestor.blocks)));
  const chainA = fork();
  const chainB = fork();
  const chainC = fork();
  mineBlocks(chainA, minerA.address, 2);
  // The sender is behind A and on another branch, so asking it settles
  // nothing; only the third peer has a chain worth adopting.
  mineBlocks(chainB, minerB.address, 1);
  mineBlocks(chainC, minerC.address, 10);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };
  const info = async (url) => (await fetch(`${url}/api/info`)).json();
  const requestsTo = (snapshot, peer) =>
    snapshot.peerTraffic.peers.find((entry) => entry.peer === peer)?.requests ??
    0;

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
    reachabilityDelayMs: 60_000,
  });
  const nodeC = startNode({
    chain: chainC,
    params: devnet,
    chainFile: path.join(dir, 'c.json'),
    port: 0,
    reachabilityDelayMs: 60_000,
  });
  let nodeA = null;

  try {
    const bUrl = await listening(nodeB);
    const cUrl = await listening(nodeC);
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      reachabilityDelayMs: 60_000,
    });
    const aUrl = await listening(nodeA);
    await fetch(`${aUrl}/api/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peers: [bUrl, cUrl] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 900));

    const before = await info(aUrl);
    const bBefore = requestsTo(before, bUrl);
    const cBefore = requestsTo(before, cUrl);

    const rejected = await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-doubloom-from': bUrl,
      },
      body: JSON.stringify(chainB.tip),
    });
    assert.equal(rejected.status, 400);

    let current = before;
    const deadline = Date.now() + 5000;
    while (current.height !== chainC.height && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await info(aUrl);
    }
    assert.equal(
      current.height,
      chainC.height,
      'the pass went on to a peer that did have a heavier chain',
    );
    assert.ok(
      requestsTo(current, bUrl) > bBefore,
      'the sender was asked first',
    );
    assert.ok(
      requestsTo(current, cUrl) > cBefore,
      'the other peer was asked when the sender had nothing to add',
    );
    assert.ok(
      logs.some((line) => line.includes(`requesting the chain from ${bUrl}`)),
      'the log still names the sender it started with',
    );
  } finally {
    await nodeA.close();
    await nodeB.close();
    await nodeC.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two mining nodes converge on one chain without manual help', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-two-miners-'));
  const wallet = new Wallet('unused.json', devnet);
  const minerA = wallet.newKey('a');
  const minerB = wallet.newKey('b');

  const ancestor = Chain.create(devnet);
  mineBlocks(ancestor, minerA.address, 110);
  const fork = () =>
    new Chain(devnet, JSON.parse(JSON.stringify(ancestor.blocks)));
  const chainA = fork();
  const chainB = fork();
  mineBlocks(chainA, minerA.address, 3);
  mineBlocks(chainB, minerB.address, 6);

  const aOwnBlock = headerHash(chainA.blocks[111].header);
  const bBlock111 = headerHash(chainB.blocks[111].header);
  const bBlock114 = headerHash(chainB.blocks[114].header);
  assert.notEqual(aOwnBlock, bBlock111, 'the branches really differ');

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
    mine: true,
    minerAddress: minerB.address,
  });
  let nodeA = null;

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  try {
    const bUrl = await listening(nodeB);
    // Give B a head start so its branch is the heavier one when A syncs.
    await new Promise((resolve) => setTimeout(resolve, 400));

    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      mine: true,
      minerAddress: minerA.address,
      peers: [bUrl],
    });
    const aUrl = await listening(nodeA);

    const deadline = Date.now() + 5000;
    while (
      !logs.some((line) => line.includes('reorg at fork #')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const reorg = logs.find((line) => line.includes('reorg at fork #'));
    assert.ok(reorg, 'a node adopted a heavier peer chain on its own');
    // The line names the switch rather than merely reporting one: fork point,
    // both tips and how much heavier the adopted branch was.
    assert.match(
      reorg,
      /^synced \d+ block\(s\), [\d.]+ (B|KiB|MiB) from http:\/\/127\.0\.0\.1:\d+ · reorg at fork #\d+: #\d+ [0-9a-f]{12}… → #\d+ [0-9a-f]{12}…, \+\d+ work$/,
    );

    // The heavier branch replaced A's own blocks at the fork point.
    const a111 = await (await fetch(`${aUrl}/api/blocks/111`)).json();
    const a114 = await (await fetch(`${aUrl}/api/blocks/114`)).json();
    assert.equal(a111.hash, bBlock111);
    assert.notEqual(a111.hash, aOwnBlock);
    assert.equal(a114.hash, bBlock114);

    const infoA = await (await fetch(`${aUrl}/api/info`)).json();
    assert.ok(infoA.height >= 116, 'the reorged node kept the winner\'s height');
    assert.ok(infoA.work.length > 0);

    // The switch is reported to clients, not just written to the log: the
    // explorer's notice reads the fork height and the tip it landed on.
    assert.ok(infoA.lastReorg, 'the reorg is visible over the API');
    assert.equal(infoA.lastReorg.forkHeight, 110);
    assert.equal(infoA.lastReorg.peer, bUrl);
    assert.ok(infoA.lastReorg.height >= 116);
    assert.match(infoA.lastReorg.tip, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(Date.parse(infoA.lastReorg.at)));

    // Equal-hashrate miners can sit on equal-work forks, which consensus never
    // breaks, so stop mining to observe the settled state: freeze B, let A run
    // ahead, then freeze A. B still has a live server, so its own
    // fork-triggered fetch pulls A's heavier chain and the tips meet.
    nodeB.setMining(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    nodeA.setMining(false);

    let converged = null;
    const convergeBy = Date.now() + 12000;
    while (Date.now() < convergeBy) {
      const tipA = headerHash(chainA.tip.header);
      const tipB = headerHash(chainB.tip.header);
      if (tipA === tipB) {
        converged = { hash: tipA, height: chainA.height };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(converged, 'both miners ended on one tip');
    assert.ok(converged.height >= 116);
    assert.equal(chainA.height, chainB.height);
    assert.equal(chainA.work, chainB.work);

    // The agreed tip is on the branch that won, and neither node still carries
    // the losing node's original blocks.
    assert.equal(
      headerHash(chainA.blocks[111].header),
      bBlock111,
      'the adopted branch is still the canonical one',
    );
  } finally {
    if (nodeA) {
      await nodeA.close();
    }
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the chain endpoint sends only the blocks after a shared locator block', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-locator-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const chain = Chain.create(devnet);
  mineBlocks(chain, miner.address, 116);

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  const node = startNode({
    chain,
    params: devnet,
    chainFile: path.join(dir, 'chain.json'),
    port: 0,
  });

  try {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const base = `http://127.0.0.1:${node.server.address().port}`;

    const full = await (await fetch(`${base}/api/chain`)).json();
    assert.equal(full.height, 116);
    assert.equal(full.blocks.length, 117);
    assert.equal(full.from, undefined);

    // Newest hash first: the highest shared block wins, so only the three
    // blocks above height 113 come back.
    const locator = [
      headerHash(chain.blocks[113].header),
      headerHash(chain.blocks[110].header),
    ].join(',');
    const sliced = await (
      await fetch(`${base}/api/chain?locator=${locator}`)
    ).json();
    assert.equal(sliced.from, 113);
    assert.equal(sliced.height, 116);
    assert.equal(sliced.blocks.length, 3);
    assert.equal(
      headerHash(sliced.blocks[0].header),
      headerHash(chain.blocks[114].header),
    );
    assert.equal(
      headerHash(sliced.blocks[2].header),
      headerHash(chain.blocks[116].header),
    );

    // An unknown newest hash falls through to the older shared one.
    const fallback = await (
      await fetch(
        `${base}/api/chain?locator=${'00'.repeat(32)},${headerHash(chain.blocks[110].header)}`,
      )
    ).json();
    assert.equal(fallback.from, 110);
    assert.equal(fallback.blocks.length, 6);

    // At the tip the peer has nothing new to send.
    const atTip = await (
      await fetch(
        `${base}/api/chain?locator=${headerHash(chain.tip.header)}`,
      )
    ).json();
    assert.equal(atTip.from, 116);
    assert.deepEqual(atTip.blocks, []);

    // A locator with no shared block falls back to the full chain.
    const unknown = await (
      await fetch(`${base}/api/chain?locator=${'00'.repeat(32)}`)
    ).json();
    assert.equal(unknown.from, null);
    assert.equal(unknown.blocks.length, 117);
  } finally {
    await node.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the node counts the bytes it exchanges with each peer', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-traffic-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');

  const chainB = Chain.create(devnet);
  mineBlocks(chainB, miner.address, 6);
  const chainA = Chain.create(devnet);

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };
  const info = async (url) => (await fetch(`${url}/api/info`)).json();

  const nodeB = startNode({
    chain: chainB,
    params: devnet,
    chainFile: path.join(dir, 'b.json'),
    port: 0,
    reachabilityDelayMs: 60_000,
  });
  let nodeA = null;

  try {
    const bUrl = await listening(nodeB);

    // A starts knowing B, so its start-up announcement and first sync both
    // reach a live peer and produce real bytes in both directions.
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      peers: [bUrl],
      reachabilityDelayMs: 60_000,
    });
    const aUrl = await listening(nodeA);

    // Wait for the chain itself, not just any traffic: the start-up
    // announcement answers first with a handful of bytes, so "some received
    // bytes" is not evidence that the sync finished.
    const oneBlock = Buffer.byteLength(JSON.stringify(chainB.blocks[1]));
    let entry = null;
    let aInfo = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      aInfo = await info(aUrl);
      entry = aInfo.peerTraffic.peers.find((peer) => peer.peer === bUrl);
      if (
        entry &&
        entry.sent > 0 &&
        entry.received > oneBlock &&
        aInfo.height === chainB.height
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(entry, 'the peer appears in the traffic list');
    assert.equal(entry.connected, true);
    assert.ok(entry.sent > 0, `sent ${entry.sent} bytes (the announcement body)`);
    assert.ok(
      entry.received > oneBlock,
      `received ${entry.received} bytes (more than one block)`,
    );
    assert.equal(entry.total, entry.sent + entry.received);
    assert.ok(entry.requests >= 1, 'every exchange is counted');
    assert.match(entry.lastAt, /^\d{4}-\d{2}-\d{2}T/);

    // The headline figures are the sum over peers, and B has not called A, so
    // its own list stays empty.
    assert.equal(aInfo.peerTraffic.sent, entry.sent);
    assert.equal(aInfo.peerTraffic.received, entry.received);
    assert.equal(aInfo.height, chainB.height, 'the bytes bought the peer chain');

    const bInfo = await info(bUrl);
    assert.deepEqual(bInfo.peerTraffic.peers, []);
    assert.equal(bInfo.peerTraffic.sent, 0);
    assert.equal(bInfo.peerTraffic.received, 0);
  } finally {
    await nodeA?.close();
    await nodeB.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node summarises the startup sync pass in one line', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-startup-sync-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const other = wallet.newKey('other');

  const chainB = Chain.create(devnet);
  mineBlocks(chainB, miner.address, 5);
  const chainA = Chain.create(devnet);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  let nodeB = null;
  let nodeA = null;
  try {
    nodeB = startNode({
      chain: chainB,
      params: devnet,
      chainFile: path.join(dir, 'b.json'),
      port: 0,
      reachabilityDelayMs: 60_000,
    });
    const bUrl = await listening(nodeB);
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      peers: [bUrl],
      reachabilityDelayMs: 60_000,
    });
    const aUrl = await listening(nodeA);

    const deadline = Date.now() + 5000;
    while (
      !logs.some((line) => line.startsWith('startup sync:')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const summary = logs.find((line) => line.startsWith('startup sync:'));
    assert.ok(summary, 'the startup pass is summarised');
    assert.match(
      summary,
      /^startup sync: 5 block\(s\), [\d.]+ (?:B|KiB) from 1 peer · height 5$/,
    );
    assert.equal(chainA.height, 5);

    // A later pass is silent: the summary describes starting up, not every sync.
    const fork = Chain.create(devnet);
    mineBlocks(fork, other.address, 7);
    await fetch(`${aUrl}/api/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fork.tip),
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      logs.filter((line) => line.startsWith('startup sync:')).length,
      1,
      'the summary is logged once, not on every sync pass',
    );
  } finally {
    await nodeA?.close();
    await nodeB?.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the startup summary reports a node that is already current', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-startup-current-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');

  const chainB = Chain.create(devnet);
  mineBlocks(chainB, miner.address, 3);
  const chainA = new Chain(
    devnet,
    JSON.parse(JSON.stringify(chainB.blocks)),
  );

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  let nodeB = null;
  let nodeA = null;
  try {
    nodeB = startNode({
      chain: chainB,
      params: devnet,
      chainFile: path.join(dir, 'b.json'),
      port: 0,
      reachabilityDelayMs: 60_000,
    });
    const bUrl = await listening(nodeB);
    nodeA = startNode({
      chain: chainA,
      params: devnet,
      chainFile: path.join(dir, 'a.json'),
      port: 0,
      peers: [bUrl],
      reachabilityDelayMs: 60_000,
    });
    await listening(nodeA);

    const deadline = Date.now() + 5000;
    while (
      !logs.some((line) => line.startsWith('startup sync:')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const summary = logs.find((line) => line.startsWith('startup sync:'));
    assert.ok(summary, 'even a node with nothing to fetch reports its pass');
    assert.match(
      summary,
      /^startup sync: up to date at height 3 \([\d.]+ (?:B|KiB) from 1 peer\)$/,
    );
    assert.equal(
      logs.filter((line) => line.startsWith('synced ')).length,
      0,
      'nothing was adopted, so no per-peer synced line appears',
    );
  } finally {
    await nodeA?.close();
    await nodeB?.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the node API pauses and resumes mining', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-mining-api-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const node = startNode({
    chain: Chain.create(devnet),
    params: devnet,
    chainFile: path.join(dir, 'chain.json'),
    port: 0,
    mine: true,
    minerAddress: miner.address,
  });
  let idle = null;

  const waitFor = async (check, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  };

  try {
    const base = await waitFor(() => {
      const address = node.server.address();
      return address ? `http://127.0.0.1:${address.port}` : null;
    });
    assert.ok(base, 'the node started listening');

    const control = (body) =>
      fetch(`${base}/api/mining`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const status = async () => (await fetch(`${base}/api/mining`)).json();
    const height = async () => (await (await fetch(`${base}/api/info`)).json()).height;

    assert.ok(
      await waitFor(async () => (await height()) >= 2),
      'the node mines at startup',
    );

    const running = await status();
    assert.equal(running.mining, true);
    assert.equal(running.address, miner.address);
    assert.ok(running.height >= 2);

    const paused = await control({ enabled: false });
    assert.equal(paused.status, 200);
    const pausedBody = await paused.json();
    assert.equal(pausedBody.ok, true);
    assert.equal(pausedBody.changed, true);
    assert.equal(pausedBody.mining, false);
    assert.equal(pausedBody.address, miner.address);
    assert.ok(pausedBody.height >= 2);

    // Let any block already in flight land, then confirm the chain stops moving.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pausedAt = await height();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await height(), pausedAt, 'no blocks are mined while paused');
    assert.equal((await status()).mining, false);
    assert.ok(
      logs.some((line) =>
        line.startsWith('mining paused via API at height '),
      ),
      'pausing is visible in the node log',
    );

    // Pausing twice is harmless and reports that nothing changed.
    const again = await (await control({ enabled: false })).json();
    assert.equal(again.changed, false);
    assert.equal(again.mining, false);

    // A body without a boolean is rejected rather than guessed at.
    const invalid = await control({});
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /enabled/);

    const resumed = await (await control({ enabled: true })).json();
    assert.equal(resumed.changed, true);
    assert.equal(resumed.mining, true);
    assert.ok(
      logs.some((line) => line === `mining resumed via API to ${miner.address}`),
      'resuming is visible in the node log',
    );

    assert.ok(
      await waitFor(async () => (await height()) > pausedAt),
      'resuming mines again from where the chain stopped',
    );

    // A node started without a payout address cannot be switched on.
    idle = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'idle.json'),
      port: 0,
      minerAddress: null,
    });
    const idleBase = await waitFor(() => {
      const address = idle.server.address();
      return address ? `http://127.0.0.1:${address.port}` : null;
    });
    const refused = await fetch(`${idleBase}/api/mining`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /no mining address/);
  } finally {
    if (idle) {
      await idle.close();
    }
    await node.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node bound to 0.0.0.0 announces a reachable address to peers', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-announce-'));

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  // Stands in for a peer so the announcement can be inspected as received.
  const announced = [];
  const capture = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/api/peers') {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.peer === 'string') {
            announced.push(parsed.peer);
          }
        } catch {
          // Malformed announcement; ignored like a real node would.
        }
      }
      const status = request.url === '/api/peers' ? 200 : 404;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"peers":[]}');
    });
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const captureUrl = `http://127.0.0.1:${capture.address().port}`;

  const nodes = [];
  const waitFor = async (check) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  // Bound to every interface, like a node on a LAN or behind port forwarding.
  const start = async (name, options = {}) => {
    const node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, `${name}.json`),
      host: '0.0.0.0',
      port: 0,
      peers: [captureUrl],
      ...options,
    });
    nodes.push(node);
    await waitFor(() => node.server.address());
    const port = node.server.address().port;
    return { node, port, base: `http://127.0.0.1:${port}` };
  };

  try {
    // An explicit public address, with a scheme and trailing slash to normalise.
    const forwarded = await start('forwarded', {
      announce: 'http://192.0.2.10:9000/',
    });
    assert.ok(
      await waitFor(() => announced.includes('http://192.0.2.10:9000')),
      'the configured address is what the peer receives',
    );
    const forwardedInfo = await (await fetch(`${forwarded.base}/api/info`)).json();
    assert.equal(forwardedInfo.announce, 'http://192.0.2.10:9000');
    // The explorer link stays local: that is where this operator opens it.
    assert.equal(forwardedInfo.explorer, `http://127.0.0.1:${forwarded.port}`);

    // The same address is left on disk for `doubloom info` to report.
    const stateFile = nodeStateFile(path.join(dir, 'forwarded.json'));
    const state = loadNodeState({ stateFile, network: devnet.name });
    assert.equal(state.announce, 'http://192.0.2.10:9000');
    assert.equal(state.url, `http://127.0.0.1:${forwarded.port}`);
    assert.equal(state.port, forwarded.port);
    assert.equal(state.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(state.startedAt)));
    assert.equal(
      loadNodeState({ stateFile, network: mainnet.name }),
      null,
      'state belonging to another network is ignored',
    );
    assert.ok(
      logs.some((line) => line === 'Announcing http://192.0.2.10:9000 to peers'),
      'the announced address is named in the startup log',
    );

    // A bare host uses the port the node actually bound.
    const bare = await start('bare', { announce: '192.0.2.11' });
    const bareExpected = `http://192.0.2.11:${bare.port}`;
    assert.ok(await waitFor(() => announced.includes(bareExpected)));

    // With no --announce, the first routable interface address is announced.
    const automatic = await start('automatic');
    const routable = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => !entry.internal && entry.family === 'IPv4');
    const automaticExpected = `http://${routable ? routable.address : '127.0.0.1'}:${automatic.port}`;
    assert.ok(
      await waitFor(() => announced.includes(automaticExpected)),
      `expected ${automaticExpected} to be announced`,
    );
    const automaticInfo = await (await fetch(`${automatic.base}/api/info`)).json();
    assert.equal(automaticInfo.announce, automaticExpected);
    assert.ok(!automaticInfo.announce.startsWith('http://0.0.0.0'));

    // Nothing was announced as loopback except the explicitly local node link.
    assert.ok(!announced.includes(`http://127.0.0.1:${forwarded.port}`));
    assert.ok(!announced.includes(`http://127.0.0.1:${automatic.port}`));

    // An address that cannot be parsed fails at startup instead of being sent.
    assert.throws(
      () =>
        startNode({
          chain: Chain.create(devnet),
          params: devnet,
          chainFile: path.join(dir, 'invalid.json'),
          port: 0,
          announce: 'http://192.0.2.10:99999',
        }),
      /--announce/,
    );
  } finally {
    for (const node of nodes) {
      await node.close();
    }
    await new Promise((resolve) => capture.close(resolve));
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node announces a chosen interface instead of the first routable address', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-chosen-iface-'));

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  // A machine with ethernet and wifi, so choosing one is observable: the seam
  // would otherwise hand out whichever comes first.
  const addresses = { eth0: '192.168.1.21', wlan0: '10.10.0.7' };
  const seam = (name) =>
    name === undefined
      ? Object.values(addresses).find(Boolean) ?? null
      : addresses[name] ?? null;

  const nodes = [];
  const waitFor = async (check) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  const start = async (name, options = {}) => {
    const node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, `${name}.json`),
      host: '0.0.0.0',
      port: 0,
      routableAddress: seam,
      announceRefreshMs: 20,
      reachabilityDelayMs: 60_000,
      ...options,
    });
    nodes.push(node);
    await waitFor(() => node.server.address());
    const port = node.server.address().port;
    return { node, port, base: `http://127.0.0.1:${port}` };
  };
  const announceOf = async (base) =>
    (await (await fetch(`${base}/api/info`)).json()).announce;

  try {
    console.log = (line) => logs.push(String(line));
    console.warn = (line) => warnings.push(String(line));

    // Each node announces its own interface, not the machine's first address.
    const eth = await start('eth', { announceInterface: 'eth0' });
    const ethExpected = `http://192.168.1.21:${eth.port}`;
    assert.equal(await announceOf(eth.base), ethExpected);
    assert.ok(
      logs.includes(`Announcing ${ethExpected} to peers (interface eth0)`),
      'the startup log names the interface the address came from',
    );
    assert.equal(
      loadNodeState({
        stateFile: nodeStateFile(path.join(dir, 'eth.json')),
        network: devnet.name,
      })?.announce,
      ethExpected,
    );

    const wifi = await start('wifi', { announceInterface: 'wlan0' });
    assert.equal(
      await announceOf(wifi.base),
      `http://10.10.0.7:${wifi.port}`,
      'the second interface is announced instead of the first routable address',
    );

    // The chosen interface loses its address: keep the last one that worked
    // rather than announcing loopback or borrowing another interface.
    addresses.eth0 = null;
    assert.ok(
      await waitFor(() =>
        warnings.some((line) =>
          line.includes(
            `interface eth0 has no routable address; still announcing ${ethExpected}`,
          ),
        ),
      ),
      'an interface without an address is reported',
    );
    assert.equal(await announceOf(eth.base), ethExpected);
    assert.equal(
      warnings.filter((line) => line.includes('interface eth0')).length,
      1,
      'the outage is reported once, not on every refresh',
    );

    // The lease comes back, possibly on a different address.
    addresses.eth0 = '192.168.3.9';
    const renewed = `http://192.168.3.9:${eth.port}`;
    assert.ok(
      await waitFor(async () => (await announceOf(eth.base)) === renewed),
      'the interface is followed once it has an address again',
    );

    // An interface with no address at startup announces loopback, loudly, and
    // then adopts the address when one appears — still never another interface.
    addresses.wlan0 = null;
    const waiting = await start('waiting', { announceInterface: 'wlan0' });
    assert.equal(await announceOf(waiting.base), `http://127.0.0.1:${waiting.port}`);
    assert.ok(
      logs.includes(
        'Interface wlan0 has no routable address yet; announcing the loopback address until it gets one',
      ),
    );
    addresses.wlan0 = '10.10.0.8';
    assert.ok(
      await waitFor(
        async () => (await announceOf(waiting.base)) === `http://10.10.0.8:${waiting.port}`,
      ),
    );
  } finally {
    for (const node of nodes) {
      await node.close();
    }
    console.log = originalLog;
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interface name that does not exist is refused at startup', async () => {
  const { startNode } = await import('../src/node.js');
  const missing = '__doubloom_missing_interface__';
  const base = {
    chain: Chain.create(devnet),
    params: devnet,
    chainFile: path.join(os.tmpdir(), 'doubloom-unused-chain.json'),
    port: 0,
    host: '0.0.0.0',
  };

  let error = null;
  try {
    startNode({ ...base, announceInterface: missing });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'an unknown interface stops the node from starting');
  assert.match(error.message, new RegExp(`unknown network interface "${missing}"`));
  // The message lists what this machine does have, so a typo is fixable from
  // the error alone.
  const names = Object.keys(os.networkInterfaces());
  if (names.length > 0) {
    assert.ok(
      names.some((name) => error.message.includes(name)),
      `expected the error to list one of ${names.join(', ')}`,
    );
  }

  // A blank name is a missing value, not an interface called "".
  assert.throws(
    () => startNode({ ...base, announceInterface: '   ' }),
    /--announce-interface requires a network interface name/,
  );

  // An explicit address and an interface are two different answers to the same
  // question, so the node refuses to guess between them.
  assert.throws(
    () =>
      startNode({
        ...base,
        announce: '192.0.2.10',
        announceInterface: 'eth0',
      }),
    /--announce and --announce-interface cannot both be given/,
  );
});

test('a wildcard node follows a network interface change while running', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-iface-'));
  const chainFile = path.join(dir, 'chain.json');

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const announced = [];
  const capture = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/api/peers') {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.peer === 'string') {
            announced.push(parsed.peer);
          }
        } catch {
          // Malformed announcement; ignored like a real node would.
        }
      }
      const status = request.url === '/api/peers' ? 200 : 404;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"peers":[]}');
    });
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const captureUrl = `http://127.0.0.1:${capture.address().port}`;

  const waitFor = async (check) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  // Stands in for this machine's interfaces; the node reads it every 20 ms.
  let interfaceAddress = '192.168.1.20';
  const nodes = [];
  const start = async (name, options = {}) => {
    const node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, `${name}.json`),
      host: '0.0.0.0',
      port: 0,
      peers: [captureUrl],
      routableAddress: () => interfaceAddress,
      announceRefreshMs: 20,
      reachabilityDelayMs: 60_000,
      ...options,
    });
    nodes.push(node);
    await waitFor(() => node.server.address());
    const port = node.server.address().port;
    return { node, port, base: `http://127.0.0.1:${port}` };
  };
  const announceOf = async (base) =>
    (await (await fetch(`${base}/api/info`)).json()).announce;

  try {
    const moving = await start('moving');
    const first = `http://192.168.1.20:${moving.port}`;
    assert.ok(
      await waitFor(async () => (await announceOf(moving.base)) === first),
      'the interface address is announced at startup',
    );

    // The host joins another network: the listener stays, the address does not.
    interfaceAddress = '10.0.0.5';
    const moved = `http://10.0.0.5:${moving.port}`;
    assert.ok(
      await waitFor(async () => (await announceOf(moving.base)) === moved),
      'the new interface address is announced',
    );
    assert.ok(
      logs.includes(
        `announced address changed from ${first} to ${moved} (network interface changed); re-announcing to peers`,
      ),
      'the change is logged with both addresses',
    );
    assert.ok(
      await waitFor(() => announced.includes(moved)),
      'peers receive the new address',
    );
    const stateFile = nodeStateFile(chainFile);
    assert.equal(
      loadNodeState({ stateFile, network: devnet.name })?.announce,
      moved,
      'the recorded address follows the change',
    );

    // Losing every routable interface falls back to loopback, and says so.
    interfaceAddress = null;
    assert.ok(
      await waitFor(
        async () => (await announceOf(moving.base)) === `http://127.0.0.1:${moving.port}`,
      ),
      'the node falls back to loopback when nothing is routable',
    );
    assert.ok(
      warnings.some((line) => line.includes('no routable address found')),
      'the fallback is warned about',
    );

    // It picks the interface back up when it returns.
    interfaceAddress = '10.0.0.7';
    const returned = `http://10.0.0.7:${moving.port}`;
    assert.ok(
      await waitFor(async () => (await announceOf(moving.base)) === returned),
      'a returning interface is announced again',
    );

    // An explicit --announce is a deliberate choice and is never overridden.
    const pinned = await start('pinned', {
      announce: '198.51.100.7',
      routableAddress: () => '10.0.0.9',
    });
    const pinnedExpected = `http://198.51.100.7:${pinned.port}`;
    await waitFor(async () => (await announceOf(pinned.base)) === pinnedExpected);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await announceOf(pinned.base), pinnedExpected);
    assert.equal(pinned.node.refreshAnnouncedAddress(), null);
  } finally {
    for (const node of nodes) {
      await node.close();
    }
    await new Promise((resolve) => capture.close(resolve));
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an address change re-announces at once and re-probes the address', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-reannounce-'));

  // A peer that records what it was told and what it was asked to dial, with
  // times, so "immediately" is measured rather than assumed.
  const announcements = [];
  const probes = [];
  const capture = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Malformed body; answered like an unknown route below.
      }
      if (
        request.method === 'POST' &&
        request.url === '/api/peers' &&
        typeof parsed?.peer === 'string'
      ) {
        announcements.push({ peer: parsed.peer, at: Date.now() });
      } else if (
        request.method === 'POST' &&
        request.url === '/api/reachability' &&
        typeof parsed?.url === 'string'
      ) {
        probes.push({ url: parsed.url, at: Date.now() });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          request.url === '/api/reachability' ? { reachable: true } : { peers: [] },
        ),
      );
    });
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const captureUrl = `http://127.0.0.1:${capture.address().port}`;

  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  const waitFor = async (check, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  let interfaceAddress = '192.168.1.20';
  let node = null;
  try {
    console.log = (line) => logs.push(String(line));
    console.warn = () => {};

    node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'chain.json'),
      host: '0.0.0.0',
      port: 0,
      peers: [captureUrl],
      routableAddress: () => interfaceAddress,
      announceRefreshMs: 20,
      // Neither timer can produce the probe below, so anything that asks the
      // peer to dial came from the address change itself.
      reachabilityDelayMs: 60_000,
      reachabilityIntervalMs: 600_000,
    });
    await waitFor(() => node.server.address());
    const port = node.server.address().port;
    const first = `http://192.168.1.20:${port}`;
    const moved = `http://10.0.0.5:${port}`;
    assert.ok(
      await waitFor(() => announcements.some((entry) => entry.peer === first)),
      'the starting address is announced',
    );

    announcements.length = 0;
    probes.length = 0;
    const changedAt = Date.now();
    interfaceAddress = '10.0.0.5';

    assert.ok(
      await waitFor(() =>
        announcements.some((entry) => entry.peer === moved),
      ),
      'the new address reaches peers without waiting for a sync pass',
    );
    const announcedAt = announcements.find((entry) => entry.peer === moved).at;
    assert.ok(
      announcedAt - changedAt < 2000,
      `the re-announcement took ${announcedAt - changedAt} ms`,
    );

    assert.ok(
      await waitFor(() => probes.some((entry) => entry.url === moved)),
      'the new address is probed',
    );
    const probedAt = probes.find((entry) => entry.url === moved).at;
    assert.ok(
      probedAt - changedAt < 3000,
      `the reachability check took ${probedAt - changedAt} ms, not the ten-minute cycle`,
    );
    assert.ok(
      probedAt >= announcedAt,
      'peers hear the new address before being asked to dial it',
    );
    assert.ok(
      !probes.some((entry) => entry.url === first),
      'the address the node no longer uses is not probed',
    );
    assert.ok(
      logs.includes(`re-announced ${moved} to 1 peer`),
      'the log says where the new address got through',
    );
  } finally {
    if (node) {
      await node.close();
    }
    await new Promise((resolve) => capture.close(resolve));
    console.log = originalLog;
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the explorer lists per-peer byte totals from the node', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /<tbody id="peers">/);
  assert.match(explorer, /<span id="peer-traffic">/);
  // Fed by /api/info, so the rows are the node's own totals rather than a
  // figure the page accumulates while it happens to be open.
  assert.match(explorer, /renderPeerTraffic\(info\.peerTraffic\)/);
  assert.match(explorer, /const entries = Array\.isArray\(traffic\?\.peers\)/);
  assert.match(explorer, /formatBytes\(entry\.received\)/);
  assert.match(explorer, /formatBytes\(entry\.sent\)/);
  // A peer that has dropped out keeps its row, marked as disconnected.
  assert.match(explorer, /entry\.connected \? "" : " muted"/);
  assert.match(explorer, /formatBytes\(traffic\.received\)|`\$\{formatBytes\(received\)\} in/);
});

test('the explorer shows the address this node announces', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /id="announce-block"/);
  assert.match(explorer, /id="announce"/);
  // Wired to the API field, not to the URL the page was opened on.
  assert.match(explorer, /info\.announce/);
});

test('the explorer header shows the last reachability result', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // The badge sits beside the announced address it describes.
  assert.match(explorer, /<span class="url" id="announce">—<\/span>\s*<span class="reach" id="reachability" hidden>/);
  // Fed by /api/info, so it reflects a check that ran on the node's schedule.
  assert.match(explorer, /renderReachability\(info\.reachability\)/);
  assert.match(explorer, /badge\.textContent = reachable \? "reachable" : "unreachable"/);
  assert.match(explorer, /badge\.className = `reach \$\{reachable \? "good" : "bad"\}`/);
  // Hidden, not empty, before the first check, so the header does not claim one.
  assert.match(explorer, /if \(!checked\) \{\s*\n\s*badge\.hidden = true;/);
  assert.match(explorer, /a peer could not reach this node/);
});

test('the explorer announces a chain switch with its fork height and tip', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /class="reorg-note" id="reorg-note"/);
  assert.match(explorer, /id="reorg-text"/);
  // Fed by the API's lastReorg, so the notice reflects the node rather than
  // the page's own guess about which chain is heavier.
  assert.match(explorer, /info\?\.lastReorg/);
  assert.match(explorer, /reorg\.forkHeight/);
  assert.match(explorer, /reorg\.tip/);
});

test('the backup panel names the node beside the schedule', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // One row carries both halves of the node's identity: the pid and the
  // address peers were told, side by side.
  const nodeRow = explorer.indexOf('<dt>Node</dt>');
  assert.ok(nodeRow > 0);
  assert.ok(
    explorer.indexOf('<dt>Schedule</dt>') < nodeRow,
    'identity follows the schedule',
  );
  assert.ok(
    !explorer.includes('<dt>Announced</dt>'),
    'the address is not a row of its own',
  );
  const row = explorer.slice(nodeRow, nodeRow + 400);
  assert.match(row, /id="backup-node"/);
  assert.match(row, /id="backup-node-pid"/);
  assert.match(row, /id="backup-node-announce"/);
  // Uptime is a live counter in the row, not only a tooltip.
  assert.match(row, /class="node-uptime" id="backup-node-uptime"/);
  assert.match(explorer, /setInterval\(renderNodeUptime, 1000\)/);
  // The row is one line: the address is the part that shrinks when space runs
  // out, so it is the span that ellipsizes.
  assert.match(row, /class="node-address" id="backup-node-announce"/);
  assert.match(explorer, /\.node-identity[\s\S]{0,200}text-overflow: ellipsis/);

  // Both values come from /api/info.
  assert.match(explorer, /const pid = Number\(info\?\.pid\)/);
  assert.match(explorer, /typeof info\?\.announce === "string"/);
  // A node without an announced address must not leave a stray separator.
  assert.match(explorer, /addressBox\.hidden = announced\.length === 0/);
});

test('the explorer has a mining control wired to the mining API', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /id="mine-toggle"/);
  // The button must POST the new state, not a fixed verb.
  assert.match(explorer, /fetch\("\/api\/mining"/);
  assert.match(explorer, /JSON\.stringify\(\{ enabled: wanted \}\)/);
  assert.match(explorer, /miningEnabled \? "Pause mining" : "Resume mining"/);
  // The status pill follows the miner: stopped reads "paused", not "live".
  assert.match(explorer, /\$\("status"\)\.textContent = info\.mining \? "mining" : "paused"/);
  assert.ok(
    !/textContent = info\.mining \? "mining" : "live"/.test(explorer),
    'the pill no longer claims to be live while the miner is stopped',
  );
  assert.match(explorer, /Miner stopped; the node is still serving peers/);
});

test('a node warns when a peer cannot reach its announced address', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-reachability-'));

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  // The address the subject announces: something that answers like a node only
  // while `targetUp` is true, so reachability can be lost and restored.
  let targetUp = true;
  const target = http.createServer((request, response) => {
    if (!targetUp || request.url !== '/api/info') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        network: 'devnet',
        height: 7,
        bestBlockHash: 'ff'.repeat(32),
        mining: false,
      }),
    );
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${target.address().port}`;

  const nodes = [];
  const waitFor = async (check) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  const open = async (name, options = {}) => {
    const node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, `${name}.json`),
      port: 0,
      ...options,
    });
    nodes.push(node);
    await waitFor(() => node.server.address());
    return { node, url: `http://127.0.0.1:${node.server.address().port}` };
  };
  const check = (url) =>
    fetch(`${url}/api/reachability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });

  try {
    // A real node answers the check by dialing the URL on the caller's behalf.
    const peer = await open('peer');

    const subject = await open('subject', {
      peers: [peer.url],
      announce: targetUrl,
      reachabilityDelayMs: 50,
      reachabilityIntervalMs: 100,
    });

    assert.ok(
      await waitFor(() =>
        logs.includes(`announced address ${targetUrl} is reachable from ${peer.url}`),
      ),
      'a reachable address is confirmed in the log',
    );

    // The same result is on the node's own /api/info, so the explorer can show
    // it without separate polling of a route that only runs on a schedule.
    const infoUp = await (await fetch(`${subject.url}/api/info`)).json();
    assert.equal(infoUp.reachability.reachable, true);
    assert.equal(infoUp.reachability.url, targetUrl);
    assert.equal(infoUp.reachability.peer, peer.url);
    assert.equal(infoUp.reachability.error, null);
    assert.match(infoUp.reachability.at, /^\d{4}-\d{2}-\d{2}T/);

    // A node that has never been checked reports null rather than a guess.
    const peerInfo = await (await fetch(`${peer.url}/api/info`)).json();
    assert.equal(peerInfo.reachability, null);

    const direct = await (await check(peer.url)).json();
    assert.equal(direct.url, targetUrl);
    assert.equal(direct.reachable, true);
    assert.equal(direct.network, 'devnet');
    assert.equal(direct.height, 7);

    const invalid = await fetch(`${peer.url}/api/reachability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'not a url' }),
    });
    assert.equal(invalid.status, 400);

    // The announced address stops answering: the peer reports that, and the
    // node says so instead of leaving the operator to guess.
    targetUp = false;
    assert.ok(
      await waitFor(() =>
        warnings.some((line) =>
          line.includes(
            `could not reach the announced address ${targetUrl}`,
          ),
        ),
      ),
      'an unreachable announced address produces a warning',
    );
    const warning = warnings.find((line) =>
      line.includes('could not reach the announced address'),
    );
    assert.match(warning, /^warning: peer http:\/\/127\.0\.0\.1:\d+ could not reach/);
    assert.ok(warning.includes(peer.url));
    assert.match(warning, /HTTP 404/);
    assert.match(warning, /--announce/);

    const down = await (await check(peer.url)).json();
    assert.equal(down.reachable, false);
    assert.match(down.error, /HTTP 404/);

    // /api/info follows the failure too, with the reason the badge shows.
    const infoDown = await (await fetch(`${subject.url}/api/info`)).json();
    assert.equal(infoDown.reachability.reachable, false);
    assert.match(infoDown.reachability.error, /HTTP 404/);
    assert.equal(infoDown.reachability.peer, peer.url);

    // And the recovery is reported once it answers again.
    targetUp = true;
    const before = logs.filter((line) =>
      line.startsWith('announced address'),
    ).length;
    assert.ok(
      await waitFor(
        () =>
          logs.filter((line) => line.startsWith('announced address')).length >
          before,
      ),
      'recovery is logged',
    );

    assert.ok(subject.node.server.listening);
  } finally {
    // Reverse order: stop the node that is probing before the node it probes,
    // or the closing peer keeps receiving requests and never finishes closing.
    for (const node of [...nodes].reverse()) {
      await node.close();
    }
    target.closeAllConnections?.();
    await new Promise((resolve) => target.close(resolve));
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a peer found by DNS discovery triggers the reachability check at once', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-discovery-reach-'));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  let peer = null;
  let subject = null;
  try {
    peer = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'peer.json'),
      port: 0,
    });
    const peerUrl = await listening(peer);
    const peerPort = peer.server.address().port;

    subject = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'subject.json'),
      port: 0,
      seeds: [`seed.example:${peerPort}`],
      seedLookup: async () => [{ address: '127.0.0.1', family: 4 }],
      // Long enough that only the discovery trigger can explain a check this
      // soon: the scheduled first check is a minute away.
      reachabilityDelayMs: 60_000,
      reachabilityIntervalMs: 600_000,
    });
    const subjectUrl = await listening(subject);

    const deadline = Date.now() + 5000;
    let info = null;
    while (Date.now() < deadline) {
      info = await (await fetch(`${subjectUrl}/api/info`)).json();
      if (info.reachability) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(info.reachability, 'the check ran without waiting for the 60s delay');
    assert.equal(info.reachability.peer, peerUrl);
    assert.equal(info.reachability.url, subjectUrl);
    assert.equal(info.reachability.reachable, true);
    assert.ok(
      logs.includes(`announced address ${subjectUrl} is reachable from ${peerUrl}`),
      'the result is logged where the discovery line is',
    );
  } finally {
    await subject?.close();
    await peer?.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a peer registered through the API triggers a reachability check', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-registered-reach-'));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  const listening = async (node) => {
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return `http://127.0.0.1:${node.server.address().port}`;
  };

  let peer = null;
  let subject = null;
  try {
    peer = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'peer.json'),
      port: 0,
    });
    const peerUrl = await listening(peer);

    subject = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'subject.json'),
      port: 0,
      reachabilityDelayMs: 60_000,
      reachabilityIntervalMs: 600_000,
    });
    const subjectUrl = await listening(subject);

    // Nothing has checked anything yet, so the result below can only come from
    // the peer this call registers.
    const before = await (await fetch(`${subjectUrl}/api/info`)).json();
    assert.equal(before.reachability, null);

    await fetch(`${subjectUrl}/api/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: peerUrl }),
    });

    const deadline = Date.now() + 5000;
    let info = null;
    while (Date.now() < deadline) {
      info = await (await fetch(`${subjectUrl}/api/info`)).json();
      if (info.reachability) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(info.reachability, 'registering a peer runs the check');
    assert.equal(info.reachability.peer, peerUrl);
    assert.equal(info.reachability.reachable, true);
  } finally {
    await subject?.close();
    await peer?.close();
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chain work is grouped until it is too long, then shortened', () => {
  // Grouped for the operator's locale: the expectation is built the same way,
  // so the test does not assume a separator.
  assert.equal(formatWork(0n), (0n).toLocaleString());
  assert.equal(formatWork(42n), (42n).toLocaleString());
  assert.equal(formatWork(1234), (1234n).toLocaleString());
  assert.equal(
    formatWork('9'.repeat(WORK_FULL_DIGITS)),
    BigInt('9'.repeat(WORK_FULL_DIGITS)).toLocaleString(),
    'the longest total that stays in full is still grouped',
  );

  // One digit more, and it becomes a magnitude: four significant digits, the
  // exact value kept by the JSON output and the card's tooltip instead.
  assert.equal(formatWork('1' + '0'.repeat(WORK_FULL_DIGITS)), '1.000e+15');
  assert.equal(formatWork('1234567890123456'), '1.234e+15');
  assert.equal(formatWork('9'.repeat(78)), '9.999e+77');
  assert.ok(
    !formatWork('1234567890123456').includes(','),
    'the shortened form is a magnitude, not a localized number',
  );

  // Anything that is not a decimal total is unknown, not zero.
  for (const value of ['', 'abc', '12a', '-1', ' 12', '1.5', null, undefined]) {
    assert.equal(formatWork(value), '—', `work ${JSON.stringify(value)}`);
  }
});

test('the explorer formats chain work exactly as the CLI does', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  const start = explorer.indexOf('const formatWork =');
  assert.ok(start > 0, 'the explorer has a formatWork helper');
  const end = explorer.indexOf('\n      };', start);
  assert.ok(end > start, 'the helper is closed');
  // The page is served as one self-contained file, so it carries a copy rather
  // than importing the module: evaluate that copy and compare every case.
  const browserFormatWork = new Function(
    `${explorer.slice(start, end + '\n      };'.length)}\nreturn formatWork;`,
  )();

  const values = [
    '0',
    '1',
    '42',
    '999',
    '1000',
    '9'.repeat(14),
    '9'.repeat(WORK_FULL_DIGITS),
    '1' + '0'.repeat(WORK_FULL_DIGITS),
    '1234567890123456',
    '9'.repeat(40),
    '9'.repeat(78),
    '000042',
    '',
    'abc',
    null,
    undefined,
    42,
    123456789n,
  ];
  for (const value of values) {
    assert.equal(
      browserFormatWork(value),
      formatWork(value),
      `the explorer and CLI differ for ${JSON.stringify(String(value))}`,
    );
  }
});

test('doubloom info prints chain work with the shared formatter', async () => {
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(
    cli,
    /row\('chain work', formatWork\(chain\.work\)\)/,
    'the text row goes through the formatter the explorer copy matches',
  );
});

test('doubloom info reports chain work in text and JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-cli-info-'));
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dir, ...args],
      { timeout: 20_000 },
    );

  try {
    await run('init');
    await run('mine', '--blocks', '3');
    const chain = loadChain(devnet, path.join(dir, 'devnet', 'chain.json'));
    assert.equal(chain.height, 3);
    const expected = chain.work.toString();

    // The plain summary carries the same total the explorer's card shows,
    // grouped with the operator's locale.
    const text = (await run('info')).stdout.replace(/\u001b\[[0-9;]*m/g, '');
    assert.match(
      text,
      new RegExp(
        `difficulty\\s+[\\d.]+\\n\\s+chain work\\s+${formatWork(chain.work)}\\n`,
      ),
    );

    // JSON keeps the exact value: a BigInt decimal string, not a rounded
    // number that would lose precision once work passes 2^53.
    const json = JSON.parse((await run('info', '--json')).stdout);
    assert.equal(json.work, expected);
    assert.match(json.work, /^\d+$/);
    assert.equal(typeof json.difficulty, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doubloom info reports whether the running node is mining', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-info-mining-'));
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dir, ...args],
      { timeout: 20_000 },
    );
  const plain = (stdout) => stdout.replace(/\u001b\[[0-9;]*m/g, '');

  const originalLog = console.log;
  console.log = () => {};
  let node = null;

  try {
    await run('init');
    const chainFile = path.join(dir, 'devnet', 'chain.json');
    const walletFile = path.join(dir, 'devnet', 'wallet.json');
    const chain = loadChain(devnet, chainFile);
    const wallet = Wallet.load(walletFile, devnet);

    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      mine: true,
      minerAddress: wallet.defaultKey().address,
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const port = node.server.address().port;

    // The miner row follows the announced address, so node identity and what it
    // is doing read together.
    const text = plain((await run('info')).stdout);
    assert.match(
      text,
      /announced\s+http:\/\/127\.0\.0\.1:\d+\s+pid \d+\r?\n\s+miner\s+mining\r?\n/,
    );

    const json = JSON.parse((await run('info', '--json')).stdout);
    assert.equal(json.node.running, true);
    assert.equal(json.node.port, port);
    assert.equal(json.node.mining, true);

    // Pausing the miner through the node's own API is what the row must follow.
    await fetch(`http://127.0.0.1:${port}/api/mining`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.match(plain((await run('info')).stdout), /miner\s+paused\r?\n/);
    assert.equal(
      JSON.parse((await run('info', '--json')).stdout).node.mining,
      false,
    );
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manual backup answers with a job that can be polled to completion', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'manual backup job passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const backupDir = path.join(dir, 'backups');

  const originalLog = console.log;
  console.log = () => {};
  let node = null;

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 10 * 60_000,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const url = `http://127.0.0.1:${node.server.address().port}`;

    // The request is answered as soon as the job exists: no archive yet, and no
    // 200 carrying a finished backup.
    const started = await fetch(`${url}/api/backup`, { method: 'POST' });
    assert.equal(started.status, 202);
    const created = await started.json();
    assert.equal(created.ok, true);
    assert.match(created.job.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(created.job.state, 'running');
    assert.equal(created.job.backup, null);
    assert.equal(created.job.error, null);
    assert.ok(Number.isFinite(Date.parse(created.job.requestedAt)));

    // A second request while one runs joins it rather than stacking an archive.
    const concurrent = await fetch(`${url}/api/backup`, { method: 'POST' });
    const concurrentBody = await concurrent.json();
    if (concurrent.status === 409) {
      assert.equal(concurrentBody.job.id, created.job.id);
      assert.equal(concurrentBody.job.state, 'running');
    } else {
      // The worker can finish a tiny devnet chain before the second request.
      assert.equal(concurrent.status, 202);
    }

    let job = created.job;
    const settledBy = Date.now() + 20_000;
    while (job.state === 'running' && Date.now() < settledBy) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = (
        await (await fetch(`${url}/api/backup/jobs/${created.job.id}`)).json()
      ).job;
    }
    assert.equal(job.state, 'succeeded');
    assert.ok(Number.isFinite(Date.parse(job.finishedAt)));
    assert.equal(job.backup.height, chain.height);
    assert.equal(job.backup.tip, headerHash(chain.tip.header));
    assert.ok(fs.existsSync(job.backup.path));
    // The node reports how far through the chain it got, and a finished run
    // has written and re-verified all of it.
    assert.equal(job.progress.percent, 100);
    assert.equal(job.progress.phase, 'verifying');
    assert.equal(job.progress.total, chain.height + 1);
    assert.equal(job.progress.done, job.progress.total);

    // The status response carries the newest job, so a reloaded page can resume
    // following the run it started instead of launching a duplicate.
    const status = await (await fetch(`${url}/api/backup`)).json();
    assert.equal(status.job.id, created.job.id);
    assert.equal(status.job.state, 'succeeded');
    assert.equal(status.lastBackup.height, chain.height);

    // Unknown ids are reported, not mistaken for a running job.
    const unknown = await fetch(`${url}/api/backup/jobs/not-a-job`);
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /unknown backup job/);

    // A node without a backup directory still refuses to start a job.
    await node.close();
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
    });
    const bareDeadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < bareDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const bareUrl = `http://127.0.0.1:${node.server.address().port}`;
    const refused = await fetch(`${bareUrl}/api/backup`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /not enabled/);
    assert.equal((await (await fetch(`${bareUrl}/api/backup`)).json()).job, null);
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backup panel shows how long the first backup has waited for sync', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // The node measures the wait; the page advances it locally so it ticks each
  // second rather than stepping once per five-second refresh.
  assert.match(
    explorer,
    /let backupSyncWaitedMs = null;\s*\n\s*let backupSyncWaitedAt = 0;/,
  );
  assert.match(
    explorer,
    /const syncWaitedNow = \(\) =>\s*\n\s*backupSyncWaitedMs === null\s*\n\s*\? null\s*\n\s*: backupSyncWaitedMs \+ Math\.max\(0, Date\.now\(\) - backupSyncWaitedAt\);/,
  );
  assert.match(explorer, /backupSyncWaitedAt = Date\.now\(\);/);
  // Only a live wait counts: a leftover figure must not keep climbing after the
  // first archive has been written.
  assert.match(
    explorer,
    /backupSyncWaitedMs =\s*\n\s*backupWaitingForSync && Number\.isFinite\(backup\?\.syncWaitedMs\)/,
  );

  // The wait appears where the countdown would be, and in the note that
  // explains why no archive exists yet.
  assert.match(
    explorer,
    /`waiting for sync\$\{\s*\n\s*Number\.isFinite\(waited\) \? ` \$\{duration\(waited\)\}` : ""\s*\n\s*\}`/,
  );
  assert.match(explorer, /const waited = backupWaitingForSync \? syncWaitedNow\(\) : null;/);
  assert.match(explorer, /Waiting for the initial peer sync\$\{/);
  // The note reads the payload it is rendering, not the cache updated later.
  assert.match(
    explorer,
    /backup\.waitingForSync && Number\.isFinite\(backup\.syncWaitedMs\)/,
  );
  // A one-second ticker already exists for the countdown, so the wait moves.
  assert.match(explorer, /setInterval\(renderNextBackup, 1000\)/);
});

test('the backup panel shows the archive size beside its height', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // The size is appended to the Archived height row, not given a row of its own.
  assert.match(explorer, /const sizeText = Number\.isFinite\(last\.bytes\)/);
  assert.match(explorer, /\$\{\s*sizeText\s*\}/);
  assert.match(explorer, /` · \$\{fileSize\(last\.bytes\)\}`/);
  // The exact byte count stays available when the rounded size is not enough.
  // The download UI no longer carries that size: it lists every retained
  // archive with its own byte count in the tooltip.
  assert.ok(
    !explorer.includes('id="backup-download"'),
    'there is no newest-only download link anymore',
  );
  assert.match(explorer, /formatNumber\(archive\.bytes\)\} bytes gzipped/);
  // The gzip saving needs the uncompressed size, so it only appears when the
  // node recorded one; older status files simply omit it.
  assert.match(explorer, /const savedPercent =\s*\n?\s*Number\.isFinite\(last\.rawBytes\) && last\.rawBytes > last\.bytes/);
  assert.match(explorer, /` · saved \$\{savedPercent\}%`/);
  assert.match(explorer, /, \$\{savedPercent\}% smaller\)/);
  // Both figures sit in the row when the node recorded the uncompressed size:
  // the compressed one alone does not say what the archive holds.
  assert.match(explorer, /` · \$\{fileSize\(last\.bytes\)\} gz · \$\{fileSize\(last\.rawBytes\)\} raw`/);
  assert.match(explorer, /const hasRaw =\s*\n?\s*Number\.isFinite\(last\.rawBytes\) && last\.rawBytes > last\.bytes/);
  // The key count recorded with the archive rides along in the tooltip.
  assert.match(explorer, /const keyText = Number\.isFinite\(last\.keys\)/);
  assert.match(explorer, /key\$\{last\.keys === 1 \? "" : "s"\}/);
  assert.match(explorer, /\}\$\{keyText\}`/);
});

test('the newest archive is restored to a temporary directory when verified', async () => {
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  const passphrase = 'verify passphrase';
  wallet.encrypt(passphrase);
  const tempRoot = path.join(dir, 'verify-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });

  const logs = [];
  const errors = [];
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60 * 60_000,
    firstDelayMs: 60 * 60_000,
    verifyIntervalMs: 60_000,
    verifyTempRoot: tempRoot,
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });

  try {
    assert.equal(schedule.status().verifyIntervalMs, 60_000);
    const written = await schedule.runNow();

    await schedule.verifyNow();
    const success = logs.find((line) => line.startsWith('backup verified:'));
    assert.ok(success, 'a successful restore is logged');
    assert.match(
      success,
      /^backup verified: doubloom-devnet-backup-\d{8}-\d{9}\.json\.gz restored to a temporary directory \(height \d+\)$/,
    );
    assert.ok(success.includes(`height ${written.height}`));
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'the temporary directory is removed');
    assert.deepEqual(errors, []);

    // A damaged archive cannot restore, and that is the point of the check.
    const archive = schedule.status().lastBackup.path;
    const goodArchive = fs.readFileSync(archive);
    fs.writeFileSync(archive, 'this is not a backup');
    await schedule.verifyNow();
    const warning = errors.find((line) => line.startsWith('warning:'));
    assert.ok(warning, 'a failed verification warns');
    assert.match(
      warning,
      /^warning: the newest backup could not be verified: doubloom-devnet-backup-\d{8}-\d{9}\.json\.gz \(/,
    );
    assert.match(warning, /may be corrupt or the wallet passphrase may have changed/);
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'a failed restore leaves no directory behind');

    // The same broken archive is reported once, not on every pass.
    await schedule.verifyNow();
    assert.equal(
      errors.filter((line) => line.startsWith('warning:')).length,
      1,
      'a corrupt archive warns once rather than on every check',
    );

    // Putting a good archive back ends the failure and says so.
    fs.writeFileSync(archive, goodArchive);
    await schedule.verifyNow();
    assert.ok(
      logs.some((line) => line.startsWith('backup verification recovered:')),
      'a recovered archive is reported',
    );
    assert.equal(
      errors.filter((line) => line.startsWith('warning:')).length,
      1,
      'the recovery adds no new warning',
    );
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node verifies its newest archive on the backup worker thread', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'node verify passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  let node = null;
  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: path.join(dir, 'backups'),
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 60 * 60_000,
        // Check almost immediately so the timer, not just the manual call, is
        // what runs the verification.
        verifyIntervalMs: 200,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const written = await node.backups.runNow();
    const verifiedBy = Date.now() + 10_000;
    while (
      !logs.some((line) => line.startsWith('backup verified:')) &&
      Date.now() < verifiedBy
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const line = logs.find((entry) => entry.startsWith('backup verified:'));
    assert.ok(line, 'the node verified the archive it just wrote');
    assert.ok(line.includes(`height ${written.height}`));
    assert.ok(
      !logs.some((entry) => entry.startsWith('warning: the newest backup')),
      'a good archive produces no warning',
    );
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scheduler records the uncompressed archive size', async () => {
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  const passphrase = 'raw size passphrase';
  wallet.encrypt(passphrase);
  const schedule = startBackupSchedule({
    params: devnet,
    chainFile,
    walletFile,
    directory: path.join(dir, 'backups'),
    passphrase,
    intervalMs: 60 * 60_000,
    firstDelayMs: 60 * 60_000,
    log: () => {},
    logError: () => {},
  });

  try {
    const result = await schedule.runNow();
    const lastBackup = schedule.status().lastBackup;
    assert.equal(lastBackup.bytes, result.bytes);
    assert.equal(lastBackup.rawBytes, result.rawBytes);
    assert.ok(
      lastBackup.rawBytes > lastBackup.bytes,
      'the uncompressed archive is larger than the gzip file',
    );
    // The status file carries it, so a restarted node still reports the saving.
    const persisted = loadBackupStatus({
      statusFile: backupStatusFile(chainFile),
      network: devnet.name,
    });
    assert.equal(persisted.lastBackup.rawBytes, result.rawBytes);
  } finally {
    schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backup panel flags an archive that is many blocks behind the tip', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // The limit comes from the node, so a node started with --backup-max-lag is
  // judged by its own figure; six is only the fallback for a node that does not
  // report one.
  assert.match(explorer, /const DEFAULT_MAX_LAG_BLOCKS = 6;/);
  assert.match(explorer, /const lagBlocks = Number\.isInteger\(backup\.maxLagBlocks\)/);
  assert.match(explorer, /behind > lagBlocks/);
  assert.match(explorer, /label = "behind tip";/);
  assert.match(explorer, /blocks behind the tip \(limit \$\{lagBlocks\}\)/);
  // The configured limit is on show beside the rest of the schedule.
  assert.match(
    explorer,
    /lag \$\{formatNumber\(backup\.maxLagBlocks\)\} block\$\{/,
  );
  assert.match(explorer, /backup\.maxLagBlocks === 1 \? "" : "s"/);
  // Age is still checked first, so an overdue archive reads as overdue; the lag
  // rule covers the archive that is recent but no longer represents the chain.
  assert.ok(
    explorer.indexOf('label = "overdue"') < explorer.indexOf('label = "behind tip"'),
    'the age check stays ahead of the lag check',
  );
  // The Archived height row reports the same figure the check uses.
  assert.match(explorer, /behind <= 0/);
  assert.match(explorer, /behind tip`/);
});

test('the node reports how far through the current backup wait it is', async () => {
  const passphrase = 'fraction passphrase';
  const { dir, chainFile, walletFile, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const realSetTimeout = globalThis.setTimeout;
  const callbacks = [];
  // A fixed, shiftable clock, and a timer that is captured instead of being
  // scheduled, so a wait can be advanced without waiting for it to elapse.
  const start = Date.UTC(2026, 9, 31, 12, 0, 0);
  let clock = start;
  let schedule;

  try {
    globalThis.setTimeout = (callback) => {
      callbacks.push(callback);
      return null;
    };
    schedule = startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile,
      directory: path.join(dir, 'backups'),
      passphrase,
      intervalMs: 60_000,
      firstDelayMs: 0,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      watchdogMs: 20,
      now: () => new Date(clock),
      log: () => {},
      logError: () => {},
    });

    // The first delay is zero, so the first run fires at once and the interval
    // that follows starts there: no time has elapsed yet.
    callbacks.shift()();
    let status = schedule.status();
    assert.equal(status.cycleMs, 60_000);
    assert.equal(status.elapsedFraction, 0);

    clock += 15_000;
    assert.equal(schedule.status().elapsedFraction, 0.25);

    // A manual archive does not restart the wait, so progress keeps climbing
    // toward the run that was already scheduled instead of dropping to zero —
    // which is what a page guessing from the interval would have shown.
    await schedule.runNow();
    assert.equal(schedule.status().elapsedFraction, 0.25);
    assert.equal(schedule.status().cycleMs, 60_000);

    // The watchdog re-arms a schedule whose timer went missing. Only the
    // remainder is armed, yet the fraction still describes the whole wait: the
    // newest archive is 30s old of a 60s interval.
    clock += 30_000;
    assert.equal(schedule.ensureScheduled(), true);
    status = schedule.status();
    assert.equal(status.cycleMs, 60_000);
    assert.equal(status.elapsedFraction, 0.5);
    assert.equal(Date.parse(status.nextRunAt), start + 75_000);

    // Nothing is pending once the schedule is stopped, so there is no fraction
    // to report rather than a stale one.
    schedule.stop();
    assert.equal(schedule.status().elapsedFraction, null);
    assert.equal(schedule.status().cycleMs, null);

    // While the first backup waits for peer sync the timer only polls, so a
    // fraction of "the wait" would be meaningless and is reported as null.
    callbacks.length = 0;
    schedule = startBackupSchedule({
      params: devnet,
      chainFile,
      walletFile,
      directory: path.join(dir, 'backups'),
      passphrase,
      intervalMs: 60_000,
      firstDelayMs: 0,
      firstReady: () => false,
      readyPollMs: 20,
      retention: { hourly: 2, daily: 0, weekly: 0 },
      watchdogMs: 20,
      now: () => new Date(clock),
      log: () => {},
      logError: () => {},
    });
    callbacks.shift()();
    assert.equal(schedule.status().waitingForSync, true);
    assert.equal(schedule.status().elapsedFraction, null);
    assert.equal(schedule.status().cycleMs, null);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    schedule?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the explorer draws a progress ring around the next backup countdown', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  assert.match(explorer, /class="countdown-ring" id="next-ring"/);
  assert.match(explorer, /id="next-ring-fill"/);
  assert.match(explorer, /\.countdown-ring \.ring-fill/);
  // The ring draws the fraction the node reports for the wait it is actually
  // running, and only advances it by the time since that figure arrived — the
  // page no longer works out where in an interval it is.
  assert.match(explorer, /const RING_CIRCUMFERENCE = 2 \* Math\.PI \* 9;/);
  assert.match(explorer, /backupElapsedFraction = Number\.isFinite\(backup\?\.elapsedFraction\)/);
  assert.match(explorer, /backupElapsedFraction \+\s*Math\.max\(0, Date\.now\(\) - backupElapsedAt\) \/ backupCycleMs/);
  assert.match(explorer, /backupCycleMs =\s*Number\.isFinite\(backup\?\.cycleMs\) && backup\.cycleMs > 0/);
  assert.equal(
    /remaining \/ backupCycleMs/.test(explorer),
    false,
    'the page must not infer the fraction from the countdown',
  );
  // It is hidden rather than empty when there is no next run, when the node
  // reports no fraction, or while the first backup is still waiting for sync.
  assert.match(explorer, /backupElapsedFraction === null/);
  assert.match(explorer, /!Number\.isFinite\(backupCycleMs\)/);
  assert.match(explorer, /ring\.toggleAttribute\("hidden", true\)/);
  // SVG elements ignore the `hidden` IDL property, so the attribute is what
  // the stylesheet keys off.
  assert.match(explorer, /ring\.toggleAttribute\("hidden", false\)/);
});

test('the explorer phrases the next backup countdown the way the terminal does', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // Clock time first, countdown parenthesised after it: the same sentence
  // `doubloom info` and `doubloom backup status` build for the same run.
  assert.match(explorer, /target\.textContent = `\$\{utcTime\(nextBackupAt\)\} \(\$\{/);
  assert.match(explorer, /formatCountdown\(remaining\)/);
  assert.match(explorer, /\}\)\$\{firstDelay\}\$\{firstWait\}`/);
  // The trailing hints come from the same fields info prints.
  assert.match(explorer, /first delay \$\{duration\(backupFirstDelayMs\)\}/);
  assert.match(explorer, /sync wait cap \$\{duration\(backupFirstMaxWaitMs\)\}/);
  assert.match(
    explorer,
    /backupFirstMaxWaitMs = Number\.isFinite\(backup\?\.firstMaxWaitMs\)/,
  );
  // A first backup held by peer sync keeps its waited time inside the same
  // parentheses, where the terminal only says `waiting for sync`.
  assert.match(explorer, /`waiting for sync\$\{/);
});

test('the explorer polls a backup job instead of blocking on the request', () => {
  const explorer = fs.readFileSync(
    new URL('../src/explorer.html', import.meta.url),
    'utf8',
  );
  // The button starts a job and follows its id; the request itself is not what
  // carries the finished archive any more.
  assert.match(explorer, /async function followBackupJob/);
  assert.match(explorer, /\/api\/backup\/jobs\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(explorer, /job\.state !== "running"/);
  assert.match(explorer, /finished\.backup\?\.height/);
  assert.match(explorer, /response\.status === 409 && started\.job\?\.state === "running"/);
  // The percentage the node reports is shown beside the elapsed wait.
  assert.match(explorer, /job\.progress\?\.percent/);
});

test('info and backup status count down to the next automatic backup', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'countdown passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

  const originalLog = console.log;
  console.log = () => {};
  let node = null;

  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dataDir, ...args],
      { timeout: 20_000 },
    ).then((result) => result.stdout.replace(/\u001b\[[0-9;]*m/g, ''));

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: path.join(dir, 'backups'),
        passphrase,
        // A ten-minute wait keeps the countdown well inside the hour, which is
        // where a single-unit countdown would be least useful.
        intervalMs: 10 * 60_000,
        firstDelayMs: 10 * 60_000,
        retention: { hourly: 2, daily: 0, weekly: 0 },
      },
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const info = await run('info');
    assert.match(info, /next backup\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(in /);
    assert.match(info, /\(in \d+m(?: \d+s)?\)/, 'info counts down in minutes and seconds');
    assert.match(info, /first delay 10 min/);

    const status = await run('backup', 'status');
    assert.match(status, /next run\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(in /);
    assert.match(status, /\(in \d+m(?: \d+s)?\)/);

    // Both name the same instant, so the two views cannot drift apart.
    const stamp = (text) => text.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC \(in /)[1];
    assert.equal(stamp(info), stamp(status));
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status says how long ago the last archive was taken', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);
  const takenAt = new Date(Date.now() - 90_000).toISOString();

  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        version: 1,
        network: devnet.name,
        pid: process.pid,
        directory: path.join(dir, 'backups'),
        intervalMs: 600_000,
        firstDelayMs: 60_000,
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        lastBackup: {
          at: takenAt,
          height: 3,
          tip: 'ab'.repeat(32),
          path: path.join(dir, 'backups', 'a.json.gz'),
          bytes: 1472,
          keys: 1,
        },
      }),
    );

    const stdout = (
      await promisify(execFile)(
        process.execPath,
        [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'status'],
        { timeout: 20_000 },
      )
    ).stdout.replace(/\u001b\[[0-9;]*m/g, '');

    // The clock time is still there; the age is beside it, in minutes and
    // seconds, followed by the height and size.
    assert.match(
      stdout,
      /last archive\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(1m \d+s ago\) · height 3 · 1,472 bytes/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each archive reports how long it took to write', () => {
  const { dir } = temporaryNode();
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // The name carries the time the attempt started; the last write is the
  // finish. Both are already on disk, so the duration needs no extra record.
  const attempt = new Date('2026-10-31T12:00:00.000Z');
  const slow = backupFileName(devnet.name, attempt);
  const fast = backupFileName(devnet.name, new Date(attempt.getTime() + 60_000));
  fs.writeFileSync(path.join(backupDir, slow), Buffer.alloc(10));
  fs.writeFileSync(path.join(backupDir, fast), Buffer.alloc(10));
  fs.utimesSync(
    path.join(backupDir, slow),
    new Date(),
    new Date(attempt.getTime() + 2_500),
  );
  fs.utimesSync(
    path.join(backupDir, fast),
    new Date(),
    new Date(attempt.getTime() + 60_250),
  );

  try {
    const archives = listArchives({ directory: backupDir, network: devnet.name });
    const byName = new Map(archives.map((archive) => [archive.name, archive]));
    assert.equal(byName.get(slow).writeMs, 2_500);
    assert.equal(byName.get(fast).writeMs, 250);
    // The attempt time is still what the archive is dated by.
    assert.equal(byName.get(slow).at, attempt.toISOString());

    // A copy whose mtime predates its name cannot have taken a negative time to
    // write, so it reports no duration rather than a nonsense one.
    fs.utimesSync(
      path.join(backupDir, fast),
      new Date(),
      new Date(attempt.getTime() + 59_000),
    );
    const copied = listArchives({ directory: backupDir, network: devnet.name })
      .find((archive) => archive.name === fast);
    assert.equal(copied.writeMs, null);
    assert.equal(copied.at, new Date(attempt.getTime() + 60_000).toISOString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status reports how long each retained archive took to write', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // Three retained archives, one per hour so the hourly tier keeps all three:
  // one written in under a second, one written in three quarters of a minute,
  // and one whose mtime says nothing usable.
  const now = Date.now();
  const attempts = [
    new Date(now - 2 * 3_600_000 - 600_000),
    new Date(now - 3_600_000 - 300_000),
    new Date(now - 60_000),
  ];
  const writes = [1_800, 45_000, -5_000];
  const names = attempts.map((attempt) => backupFileName(devnet.name, attempt));
  names.forEach((name, index) => {
    fs.writeFileSync(path.join(backupDir, name), Buffer.alloc(1_200));
    fs.utimesSync(
      path.join(backupDir, name),
      new Date(),
      new Date(attempts[index].getTime() + writes[index]),
    );
  });

  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      version: 1,
      network: devnet.name,
      pid: process.pid,
      directory: backupDir,
      intervalMs: 600_000,
      firstDelayMs: 60_000,
      maxAgeMs: 1_500_000,
      retention: { hourly: 3, daily: 0, weekly: 0 },
      recoveryHistoryLimit: 3,
      nextRunAt: null,
      waitingForSync: false,
      lastAttemptAt: null,
      lastError: null,
      lastBackup: {
        at: attempts[2].toISOString(),
        height: 3,
        path: path.join(backupDir, names[2]),
        bytes: 1_200,
      },
      lastRecovery: null,
      recoveryHistory: [],
      // The schedule records both ends of its own writes; these outrank the
      // mtimes below, which a copy could have moved.
      archiveWrites: {
        [names[1]]: {
          startedAt: attempts[1].toISOString(),
          finishedAt: new Date(attempts[1].getTime() + 7_000).toISOString(),
        },
        // A half-written record is ignored rather than trusted.
        [names[0]]: { startedAt: attempts[0].toISOString() },
      },
    }),
  );

  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        dataDir,
        'backup',
        'status',
        ...args,
      ],
      { timeout: 20_000 },
    ).then((result) => result.stdout.replace(/\u001b\[[0-9;]*m/g, ''));

  try {
    const stdout = await run();
    // `backup status` prints UTC to the second, unlike `backup list`.
    const stamp = (date) =>
      date.toISOString().slice(0, 19).replace('T', ' ');
    const line = (index) =>
      stdout
        .split('\n')
        .find(
          (entry) =>
            entry.includes('retained') && entry.includes(stamp(attempts[index])),
        );

    // Sub-second writes keep their milliseconds; longer ones read in seconds.
    // The middle archive's mtime says 45s but its record says 7s, and the record
    // is the one that describes the run; the first archive's record is
    // incomplete, so its mtime is used instead of a partial pair.
    assert.match(line(0), /1\.2 KiB · wrote in 1\.8s/);
    assert.match(line(1), /1\.2 KiB · wrote in 7\.0s/);
    assert.match(line(2), /1\.2 KiB · write time not recorded/);
    // Newest first, like every other archive listing.
    assert.ok(
      stdout.indexOf(stamp(attempts[1])) < stdout.indexOf(stamp(attempts[0])),
      'retained archives are listed newest first',
    );

    // The same figures are in the script-friendly record.
    const payload = JSON.parse(await run('--json'));
    assert.equal(payload.archives.length, 3);
    assert.deepEqual(
      payload.archives.map((archive) => archive.name),
      [names[2], names[1], names[0]],
    );
    assert.deepEqual(
      payload.archives.map((archive) => archive.writeMs),
      [null, 7_000, 1_800],
    );
    assert.equal(payload.archives[0].at, attempts[2].toISOString());
    assert.equal(payload.archives[0].bytes, 1_200);
    // The two ends are reported beside the duration, so a script does not have
    // to subtract it from the archive time to place the write.
    assert.deepEqual(payload.archives[1].startedAt, attempts[1].toISOString());
    assert.equal(
      payload.archives[1].finishedAt,
      new Date(attempts[1].getTime() + 7_000).toISOString(),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status shows the archive raw size and key count', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);
  const path_ = path.join(dir, 'backups', 'a.json.gz');

  const writeStatus = (lastBackup) => {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        version: 1,
        network: devnet.name,
        pid: process.pid,
        directory: path.join(dir, 'backups'),
        intervalMs: 600_000,
        firstDelayMs: 60_000,
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        lastBackup,
      }),
    );
  };

  const run = () =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'status'],
      { timeout: 20_000 },
    ).then((result) => result.stdout.replace(/\u001b\[[0-9;]*m/g, ''));

  try {
    // Both sizes, the saving between them, and how many keys the archive holds.
    writeStatus({
      at: new Date(Date.now() - 60_000).toISOString(),
      height: 3,
      path: path_,
      bytes: 1_481,
      rawBytes: 5_669,
      keys: 2,
    });
    const full = await run();
    assert.match(
      full,
      /last archive\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(1m(?: \d+s)? ago\) · height 3 · 1,481 bytes gzipped \(from 5,669 raw, 74% smaller\) · 2 keys/,
    );

    // One key reads as a key, not as keys.
    writeStatus({
      at: new Date(Date.now() - 60_000).toISOString(),
      height: 3,
      path: path_,
      bytes: 1_481,
      rawBytes: 5_669,
      keys: 1,
    });
    assert.match(await run(), /74% smaller\) · 1 key$/m);

    // A status file written before these fields existed still prints its size,
    // without inventing a raw figure or a key count.
    writeStatus({
      at: new Date(Date.now() - 60_000).toISOString(),
      height: 3,
      path: path_,
      bytes: 1_481,
    });
    const older = await run();
    assert.match(older, /height 3 · 1,481 bytes$/m);
    assert.equal(/raw|key/.test(older), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retention reports which tier keeps each archive', () => {
  const archive = (stamp) => {
    const at = new Date(stamp);
    return { name: backupFileName(devnet.name, at), at };
  };
  const archives = [
    archive('2026-10-31T12:00:00Z'),
    archive('2026-10-31T11:30:00Z'),
    archive('2026-10-31T11:00:00Z'),
    archive('2026-10-31T10:00:00Z'),
    archive('2026-10-30T12:00:00Z'),
    archive('2026-10-29T12:00:00Z'),
    archive('2026-10-28T12:00:00Z'),
    archive('2026-10-24T12:00:00Z'),
    archive('2026-10-17T12:00:00Z'),
    archive('2026-10-10T12:00:00Z'),
  ];
  const retention = { hourly: 2, daily: 3, weekly: 2 };
  const assignments = retentionAssignments(archives, retention);

  // The newest archive fills its hour, day and week at once, and the labels are
  // ordered by tier rather than by which loop happened to record them first.
  assert.deepEqual(assignments.get(archives[0].name), [
    'hourly',
    'daily',
    'weekly',
  ]);
  assert.deepEqual(assignments.get(archives[1].name), ['hourly']);
  assert.deepEqual(assignments.get(archives[4].name), ['daily']);
  assert.deepEqual(assignments.get(archives[5].name), ['daily']);
  assert.deepEqual(assignments.get(archives[7].name), ['weekly']);

  // Everything else is waiting to be pruned, so it has no entry at all.
  for (const index of [2, 3, 6, 8, 9]) {
    assert.equal(
      assignments.has(archives[index].name),
      false,
      `${archives[index].name} is not kept`,
    );
  }

  // The set pruning uses is exactly the map's keys, so what one command reports
  // as kept is what the other preserves.
  assert.deepEqual(
    [...retentionAssignments(archives, retention).keys()].sort(),
    [...selectRetained(archives, retention)].sort(),
  );
});

test('backup list shows each archive with its size and retention tier', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  // Four archives at fixed instants, so each is kept by a different tier and the
  // answer cannot drift with the day the suite happens to run. Distances from
  // `Date.now()` would: 26 hours back leaves the current ISO week whenever the
  // run starts on a Monday before 02:00 UTC, which hands the second weekly slot
  // to the 26-hour archive and leaves the 8-day one prunable. Here A and B share
  // one ISO week (B is the older of the two, so only daily keeps it), C is the
  // previous week's keeper, and D is older than both kept weeks.
  const dates = [
    new Date('2026-03-10T12:00:00Z'), // A: Tuesday, ISO week 11
    new Date('2026-03-09T12:00:00Z'), // B: Monday, ISO week 11
    new Date('2026-03-06T12:00:00Z'), // C: Friday, ISO week 10
    new Date('2026-02-20T12:00:00Z'), // D: Friday, ISO week 8
  ];
  const names = dates.map((date) => backupFileName(devnet.name, date));
  [1500, 2048, 512, 3_000_000].forEach((bytes, index) => {
    fs.writeFileSync(path.join(backupDir, names[index]), Buffer.alloc(bytes));
  });

  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      version: 1,
      network: devnet.name,
      pid: process.pid,
      directory: backupDir,
      intervalMs: 600_000,
      firstDelayMs: 60_000,
      maxAgeMs: 1_200_000,
      retention: { hourly: 1, daily: 2, weekly: 2 },
      recoveryHistoryLimit: 3,
      nextRunAt: null,
      waitingForSync: false,
      lastAttemptAt: null,
      lastError: null,
      lastBackup: null,
      lastRecovery: null,
      recoveryHistory: [],
    }),
  );

  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        dataDir,
        'backup',
        'list',
        ...args,
      ],
      { timeout: 20_000 },
    ).then((result) => result.stdout);

  const stamp = (date) => date.toISOString().replace('T', ' ').replace('Z', '');

  try {
    const output = await run();
    // Colour is a terminal affordance, not content: compare the text.
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    const line = (date) =>
      plain.split('\n').find((entry) => entry.includes(stamp(date)));

    // The recorded directory is used when --backup-dir is not given.
    assert.ok(output.includes(backupDir), 'the directory is named');

    // Newest first, each with its size and the tier that keeps it.
    assert.match(line(dates[0]), /1\.5 KiB\s+hourly · daily · weekly/);
    assert.match(line(dates[1]), /2\.0 KiB\s+daily/);
    assert.match(line(dates[2]), /512 B\s+weekly/);
    assert.match(line(dates[3]), /2\.9 MiB\s+prunable/);
    assert.ok(
      output.indexOf(stamp(dates[0])) < output.indexOf(stamp(dates[1])),
      'archives are listed newest first',
    );

    // The footer totals what is on disk and restates the policy that decided
    // the tiers above.
    assert.match(plain, /4 archives · 2\.9 MiB total · keep hourly 1 · daily 2 · weekly 2/);

    // An explicit directory wins, and an empty one says so rather than failing.
    const empty = path.join(dir, 'empty-backups');
    fs.mkdirSync(empty);
    const emptyOutput = await run('--backup-dir', empty);
    assert.match(emptyOutput, /no archives yet/);
    assert.ok(!emptyOutput.includes(names[0]), 'the recorded directory was not used');

    // With no directory anywhere, the command says what to do instead of
    // silently listing some other place.
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          cliPath,
          '--network',
          'devnet',
          '--datadir',
          path.join(dir, 'unconfigured'),
          'backup',
          'list',
        ],
        { timeout: 20_000 },
      ),
      /no backup directory known/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status --json reports a computed verdict', async () => {
  const { dir, chainFile, chain } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  const write = (overrides) => {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        version: 1,
        network: devnet.name,
        pid: process.pid,
        directory: backupDir,
        intervalMs: 600_000,
        firstDelayMs: 60_000,
        maxAgeMs: 1_200_000,
        maxLagBlocks: 5,
        retention: { hourly: 2, daily: 0, weekly: 0 },
        ...overrides,
      }),
    );
  };
  const archive = (overrides = {}) => ({
    at: iso(-60_000),
    height: chain.height,
    tip: 'ab'.repeat(32),
    path: path.join(backupDir, 'a.json.gz'),
    bytes: 1_200,
    ...overrides,
  });

  const read = async () => {
    const stdout = (
      await promisify(execFile)(
        process.execPath,
        [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'status', '--json'],
        { timeout: 20_000 },
      )
    ).stdout;
    return JSON.parse(stdout);
  };

  try {
    // No schedule recorded at all is not the same as a broken one.
    const unconfigured = await read();
    assert.equal(unconfigured.verdict, 'unknown');
    assert.equal(unconfigured.lastArchiveAgeMs, null, 'no archive, no age');
    assert.equal(unconfigured.maxArchiveAgeMs, null, 'no schedule, no limit');
    // The chain on disk is what the lag rule measures against, so a script can
    // reproduce the comparison without a node.
    assert.equal(unconfigured.tipHeight, chain.height);

    // A schedule that has not written its first archive yet.
    write({ lastBackup: null });
    assert.equal((await read()).verdict, 'waiting');

    // Fresh and at the tip. The age is reported in milliseconds, measured from
    // the same instant the verdict was reached, so a script needs no clock of
    // its own; the archive above is a minute old.
    write({ lastBackup: archive() });
    const fresh = await read();
    assert.equal(fresh.verdict, 'healthy');
    assert.ok(
      fresh.lastArchiveAgeMs >= 59_000 && fresh.lastArchiveAgeMs < 120_000,
      `a one-minute-old archive reports its age (${fresh.lastArchiveAgeMs})`,
    );
    assert.equal(fresh.maxArchiveAgeMs, 1_200_000);

    // Older than the age limit reads `stale`, the word the panel's `overdue`
    // stands for, and the reported age is past the reported limit.
    write({ lastBackup: archive({ at: iso(-40 * 60_000) }) });
    const stale = await read();
    assert.equal(stale.verdict, 'stale');
    assert.ok(
      stale.lastArchiveAgeMs >= 2_400_000,
      `the age crosses the limit (${stale.lastArchiveAgeMs})`,
    );
    assert.ok(stale.lastArchiveAgeMs > stale.maxArchiveAgeMs);

    // With no recorded limit, the effective one is twice the interval — the
    // same fallback the verdict applied, so the pair stays comparable.
    write({ maxAgeMs: null, lastBackup: archive({ at: iso(-40 * 60_000) }) });
    const derived = await read();
    assert.equal(derived.maxAgeMs, null);
    assert.equal(derived.maxArchiveAgeMs, 1_200_000, '2 × the 10 minute interval');
    assert.equal(derived.verdict, 'stale');

    // Within the age limit but further behind the tip than the lag limit.
    write({ lastBackup: archive({ height: chain.height - 6 }) });
    assert.equal((await read()).verdict, 'behind');

    // An attempt that failed after the archive was written is reported as such
    // rather than as a stale archive.
    write({
      lastBackup: archive({ at: iso(-40 * 60_000) }),
      lastAttemptAt: iso(-10_000),
      lastError: 'disk full',
    });
    assert.equal((await read()).verdict, 'failed');

    // Age outranks lag when both apply, as the panel orders them.
    write({
      lastBackup: archive({ at: iso(-40 * 60_000), height: chain.height - 6 }),
    });
    assert.equal((await read()).verdict, 'stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status --json prints the record for scripts', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);

  const run = async (...args) =>
    (
      await promisify(execFile)(
        process.execPath,
        [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'status', ...args],
        { timeout: 20_000 },
      )
    ).stdout;

  try {
    // Nothing configured yet: still machine-readable, and explicit about it.
    const empty = JSON.parse(await run('--json'));
    assert.equal(empty.network, 'devnet');
    assert.equal(empty.configured, false);
    assert.equal(empty.running, false);
    assert.equal(empty.lastBackup, null);
    assert.deepEqual(empty.recoveryHistory, []);
    assert.equal(empty.statusFile, statusFile);

    const lastBackup = {
      at: '2026-10-31T04:00:00.000Z',
      height: 3,
      tip: 'ab'.repeat(32),
      path: path.join(dir, 'backups', 'doubloom-devnet-backup-20261031-040000000.json.gz'),
      bytes: 1472,
      keys: 1,
    };
    const recovery = { at: '2026-10-31T03:50:00.000Z', reason: 'timer was missing' };
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        version: 1,
        network: devnet.name,
        pid: process.pid,
        directory: path.join(dir, 'backups'),
        intervalMs: 600_000,
        firstDelayMs: 60_000,
        maxAgeMs: 1_200_000,
        retention: { hourly: 2, daily: 0, weekly: 0 },
        recoveryHistoryLimit: 3,
        nextRunAt: '2026-10-31T05:00:00.000Z',
        waitingForSync: false,
        lastAttemptAt: lastBackup.at,
        lastError: null,
        lastBackup,
        lastRecovery: recovery,
        recoveryHistory: [recovery],
      }),
    );

    const record = JSON.parse(await run('--json'));
    assert.equal(record.configured, true);
    assert.equal(record.running, true, 'the recorded pid is this live test process');
    assert.equal(record.pid, process.pid);
    assert.equal(record.intervalMs, 600_000);
    assert.equal(record.firstDelayMs, 60_000);
    assert.equal(record.maxAgeMs, 1_200_000);
    assert.deepEqual(record.retention, { hourly: 2, daily: 0, weekly: 0 });
    assert.equal(record.recoveryHistoryLimit, 3);
    assert.equal(record.nextRunAt, '2026-10-31T05:00:00.000Z');
    assert.deepEqual(record.lastBackup, lastBackup);
    assert.deepEqual(record.lastRecovery, recovery);
    assert.deepEqual(record.recoveryHistory, [recovery]);

    // Plain output is unchanged and still the default.
    const text = await run();
    assert.match(text, /Automatic backups/);
    assert.match(text, /last archive/);
    assert.ok(!text.trimStart().startsWith('{'), 'no JSON without the flag');

    // Attempts and recoveries read as ages too, not only as stamps, so the
    // panel answers "how long ago" without the reader doing the subtraction.
    // Written relative to now so the expected wording cannot drift.
    const recent = new Date(
      Date.now() - (3 * 3600 + 30 * 60) * 1000,
    ).toISOString();
    const older = new Date(
      Date.now() - (2 * 24 * 3600 + 3600) * 1000,
    ).toISOString();
    const withAges = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    withAges.lastAttemptAt = recent;
    withAges.lastRecovery = { at: recent, reason: 'timer was overdue' };
    withAges.recoveryHistory = [
      { at: recent, reason: 'timer was overdue' },
      { at: older, reason: 'timer was missing' },
    ];
    fs.writeFileSync(statusFile, JSON.stringify(withAges));

    // Both rows read `<utc stamp> (<age>) · <reason>`: the stamp stays exact and
    // the age sits beside it, the same shape the last archive row uses. The
    // age is dimmed, so match against the text with its colour codes removed.
    const aged = (await run()).replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(
      aged,
      /last attempt\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(3h 30m ago\)/,
      'the attempt carries how long ago it was',
    );
    assert.match(
      aged,
      /last recovery\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(3h 30m ago\) · timer was overdue/,
      'the newest recovery carries its age beside its reason',
    );
    assert.match(
      aged,
      /earlier\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(2d 1h ago\) · timer was missing/,
      'retained recoveries carry ages too',
    );

    // A failed run must report its error verbatim, with when it was attempted,
    // while the schedule itself stays readable — a script polling the error
    // should not lose the next run time because the last attempt failed.
    const withError = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    withError.lastError = "EEXIST: file already exists, mkdir '/srv/backups'";
    withError.lastAttemptAt = '2026-10-31T04:30:00.000Z';
    fs.writeFileSync(statusFile, JSON.stringify(withError));

    const failure = JSON.parse(await run('--json'));
    assert.equal(failure.lastError, withError.lastError);
    assert.equal(failure.lastAttemptAt, '2026-10-31T04:30:00.000Z');
    assert.equal(failure.nextRunAt, '2026-10-31T05:00:00.000Z');
    assert.equal(failure.intervalMs, 600_000);

    // A status file left behind by an exited node still holds the next run it
    // intended, but that run will never happen: report it as unscheduled so a
    // script does not wait on a dead timestamp.
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = exited.pid;
    await new Promise((resolve) => exited.once('exit', resolve));
    assert.throws(() => process.kill(deadPid, 0), 'the recording process is gone');

    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        version: 1,
        network: devnet.name,
        pid: deadPid,
        directory: path.join(dir, 'backups'),
        intervalMs: 600_000,
        nextRunAt: '2026-10-31T05:00:00.000Z',
        waitingForSync: true,
        lastBackup,
      }),
    );

    const stale = JSON.parse(await run('--json'));
    assert.equal(stale.running, false);
    assert.equal(stale.pid, deadPid);
    assert.equal(stale.nextRunAt, null, 'a dead node has no next run');
    assert.equal(stale.waitingForSync, false);
    // What already happened is still reported: only the future is dropped.
    assert.deepEqual(stale.lastBackup, lastBackup);
    assert.equal(stale.intervalMs, 600_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup status --watch follows the schedule while the node runs', async () => {
  const { dir, chainFile } = temporaryNode();
  const dataDir = path.join(dir, 'data');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const statusFile = backupStatusFile(chainFile);

  // Stand-in for the node: a process the status file records as its owner,
  // which the test ends to model a node shutting down.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const args = [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'status'];
  const watcher = spawn(process.execPath, [...args, '--watch'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let diagnostics = '';
  // Attached before any waiting starts: the watch can finish while a wait is
  // still polling, and a listener registered afterwards would never fire.
  const exitCode = new Promise((resolve) => watcher.once('exit', resolve));
  watcher.stdout.on('data', (chunk) => {
    output += chunk;
  });
  watcher.stderr.on('data', (chunk) => {
    diagnostics += chunk;
  });

  const waitFor = async (predicate, what) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}; saw:\n${output}${diagnostics}`);
  };

  const record = (nextRunAt) => ({
    version: 1,
    network: devnet.name,
    pid: owner.pid,
    directory: path.join(dir, 'backups'),
    intervalMs: 600_000,
    firstDelayMs: 60_000,
    maxAgeMs: 1_200_000,
    retention: { hourly: 2, daily: 0, weekly: 0 },
    recoveryHistoryLimit: 3,
    nextRunAt,
    waitingForSync: false,
    lastAttemptAt: null,
    lastError: null,
    lastBackup: null,
    lastRecovery: null,
    recoveryHistory: [],
  });

  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(record('2026-10-31T05:00:00.000Z')));

    await waitFor(() => output.includes('running'), 'the first panel');
    assert.match(output, /Automatic backups/);
    assert.ok(
      output.includes('2026-10-31 05:00:00 UTC'),
      'the panel shows when the next run is due',
    );
    assert.match(output, /watching · refresh 1s/);

    // The node re-arms its schedule: the panel is redrawn from the new record,
    // so following the file is visibly a refresh and not a stale first read.
    fs.writeFileSync(statusFile, JSON.stringify(record('2026-10-31T06:30:00.000Z')));
    await waitFor(
      () => output.includes('2026-10-31 06:30:00 UTC'),
      'the panel to follow the new schedule',
    );

    // Piped output is a log, so it must not carry cursor control: a second copy
    // would otherwise be printed every second with nothing changed.
    assert.ok(!output.includes('\x1b[?25'), 'no cursor hiding when piped');
    assert.ok(!/\x1b\[\d+A/.test(output), 'no cursor rewinding when piped');

    // The node exits: the watch ends by itself instead of spinning forever.
    owner.kill();
    await waitFor(() => output.includes('watch ended'), 'the watch to end with the node');
    assert.equal(await exitCode, 0, 'a node stopping is a clean end, not a failure');

    // A live panel and one-off JSON are different jobs; asking for both is a
    // usage error rather than a JSON document full of redraws.
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [...args, '--watch', '--json'],
        { timeout: 20_000 },
      ),
      /--watch redraws the panel/,
    );
  } finally {
    watcher.kill();
    owner.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backup now command drives an immediate backup on a running node', async () => {
  const { startNode } = await import('../src/node.js');
  const passphrase = 'backup now passphrase';
  const { dir, chainFile, walletFile, chain, wallet } = temporaryNode();
  wallet.encrypt(passphrase);
  const dataDir = path.join(dir, 'data');
  const backupDir = path.join(dir, 'backups');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

  const originalLog = console.log;
  console.log = () => {};
  let node = null;
  let bare = null;

  const listening = async (instance) => {
    const deadline = Date.now() + 3000;
    while (!instance.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return instance.server.address().port;
  };
  const run = (...args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'now', ...args],
      { timeout: 30_000 },
    );
  const failure = (args) =>
    promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', '--datadir', dataDir, 'backup', 'now', ...args],
      { timeout: 30_000 },
    ).then(
      () => null,
      (error) => error,
    );

  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
      backup: {
        directory: backupDir,
        passphrase,
        intervalMs: 60 * 60_000,
        firstDelayMs: 10 * 60_000,
        retention: { hourly: 3, daily: 0, weekly: 0 },
      },
    });
    const port = await listening(node);
    const nodeUrl = `http://127.0.0.1:${port}`;
    const status = async () => (await fetch(`${nodeUrl}/api/backup`)).json();

    // Nothing is archived until the command asks for one.
    assert.equal((await status()).lastBackup, null);

    const result = await run('--port', String(port));
    assert.match(result.stdout, /Backup written and verified on the node/);
    assert.ok(result.stdout.includes(nodeUrl), 'the node is named');

    // The archive the node reports is the one just written, at the tip.
    const archived = await status();
    assert.ok(archived.lastBackup, 'the node recorded the backup');
    assert.equal(archived.lastBackup.height, chain.height);
    assert.ok(result.stdout.includes(archived.lastBackup.path));
    assert.ok(
      result.stdout.includes(headerHash(chain.tip.header)),
      'the report names the tip it archived',
    );
    assert.ok(fs.existsSync(archived.lastBackup.path));
    const bytes = fs.readFileSync(archived.lastBackup.path);
    assert.equal(bytes[0], 0x1f, 'the archive is gzip');
    assert.equal(bytes[1], 0x8b);

    // Without --port the node's recorded port is used, so an operator does not
    // have to remember how the node was started.
    const recorded = await run();
    assert.match(recorded.stdout, /Backup written and verified on the node/);
    assert.ok(recorded.stdout.includes(nodeUrl));
    const afterRecorded = await status();
    assert.equal(afterRecorded.lastBackup.height, chain.height);
    assert.notEqual(
      afterRecorded.lastBackup.path,
      archived.lastBackup.path,
      'the second backup is a new archive',
    );

    // An explicit destination writes an export outside the retention directory
    // and leaves the schedule's own bookkeeping alone.
    const archiveCount = (await status()).archives.length;
    const exportPath = path.join(dir, 'exports', 'node-snapshot.json');
    const exported = await run('--port', String(port), '--to', exportPath);
    assert.match(exported.stdout, /Backup written and verified on the node/);
    assert.ok(
      fs.existsSync(`${exportPath}.gz`),
      'the archive landed where it was asked',
    );
    assert.ok(exported.stdout.includes(`${exportPath}.gz`));
    assert.match(
      exported.stdout,
      /outside the node's backup directory, where retention/,
      'the footer says this copy is not managed by retention',
    );
    assert.ok(
      exported.stdout.includes(headerHash(chain.tip.header)),
      'the export names the tip it archived',
    );
    const afterExport = await status();
    assert.equal(
      afterExport.lastBackup.path,
      afterRecorded.lastBackup.path,
      'an export does not replace the recorded backup',
    );
    assert.equal(afterExport.archives.length, archiveCount);

    // A destination the node would have to manage as part of retention is
    // refused, and the reason names both paths.
    const inside = path.join(backupDir, 'inside.json');
    const refusedExport = await failure(['--port', String(port), '--to', inside]);
    assert.ok(refusedExport, 'a path inside the backup directory is refused');
    assert.match(refusedExport.stderr, /inside the retention directory/);

    // A node without --backup-dir cannot back up, and says how to fix it.
    await node.close();
    node = null;
    bare = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      port: 0,
    });
    const barePort = await listening(bare);
    const refused = await failure(['--port', String(barePort)]);
    assert.ok(refused, 'a node without backups refuses the request');
    assert.match(refused.stderr, /has no backup directory/);
    assert.match(refused.stderr, /--backup-dir/);

    // Nothing listening is reported as such instead of a confusing HTTP error.
    await bare.close();
    bare = null;
    const unreachable = await failure(['--port', String(barePort)]);
    assert.ok(unreachable, 'an unreachable node fails');
    assert.match(unreachable.stderr, /no node answering at/);
  } finally {
    if (node) {
      await node.close();
    }
    if (bare) {
      await bare.close();
    }
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup now reports elapsed time while the node verifies', async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'doubloom-backup-progress-'),
  );
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const archive = {
    path: path.join(
      dir,
      'backups',
      'doubloom-devnet-backup-20261031-000000000.json.gz',
    ),
    bytes: 1_468,
    rawBytes: 3_878,
    height: 3,
    tip: 'a'.repeat(64),
    keys: 1,
  };

  let polls = 0;
  let runningUntil = null;
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (pathname === '/api/backup' && request.method === 'POST') {
      send(202, { ok: true, job: { id: 'job-1', state: 'running' } });
      return;
    }
    if (pathname === '/api/backup/jobs/job-1') {
      polls += 1;
      // Held open longer than the five seconds a piped run reports on, timed
      // from the first poll so CLI start-up cannot eat the interval.
      runningUntil ??= Date.now() + 5_600;
      if (Date.now() < runningUntil) {
        send(200, {
          job: {
            id: 'job-1',
            state: 'running',
            progress: {
              phase: 'verifying',
              done: 750,
              total: 1_000,
              percent: 75,
            },
          },
        });
        return;
      }
      send(200, {
        job: {
          id: 'job-1',
          state: 'succeeded',
          finishedAt: new Date().toISOString(),
          backup: { ...archive, at: new Date().toISOString() },
        },
      });
      return;
    }
    if (pathname === '/api/backup') {
      send(200, { enabled: true, nextRunAt: null });
      return;
    }
    send(404, { error: 'not found' });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const result = await promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        '--datadir',
        dir,
        'backup',
        'now',
        '--port',
        String(port),
      ],
      { timeout: 30_000 },
    );

    const waited = result.stdout
      .split('\n')
      .filter((line) => line.includes('waiting for the node'));
    assert.ok(waited.length > 0, `the wait is reported: ${result.stdout}`);
    // The percentage the node reports is on the same line as the clock.
    assert.match(
      waited[0],
      /waiting for the node · 75% verified \([\d,]+\/[\d,]+ blocks\) · \d+s/,
    );
    // The report still follows once the job finishes, unchanged.
    assert.match(result.stdout, /Backup written and verified on the node/);
    assert.ok(result.stdout.includes(archive.path));
    assert.ok(polls > 1, 'the job was polled while it ran');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mining command pauses and resumes a running node', async () => {
  const { startNode } = await import('../src/node.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-cli-mining-'));
  const wallet = new Wallet('unused.json', devnet);
  const miner = wallet.newKey('miner');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  let node = null;

  try {
    node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'chain.json'),
      port: 0,
      mine: true,
      minerAddress: miner.address,
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const port = node.server.address().port;

    // Runs the real CLI, the way an operator would from a shell.
    const mining = (args) =>
      promisify(execFile)(
        process.execPath,
        [cliPath, '--network', 'devnet', 'mining', ...args, '--port', String(port)],
        { timeout: 10_000 },
      );
    const state = async () =>
      (await fetch(`http://127.0.0.1:${port}/api/mining`)).json();

    const status = await mining(['status']);
    assert.match(status.stdout, /Mining/);
    assert.match(status.stdout, /mining/);
    assert.match(status.stdout, new RegExp(miner.address));
    assert.ok(status.stdout.includes(`127.0.0.1:${port}`));

    // --json is the scriptable form: stable keys and types, no colour codes.
    const jsonStatus = await mining(['status', '--json']);
    assert.ok(
      !jsonStatus.stdout.includes('\u001b['),
      'JSON output carries no terminal colour codes',
    );
    const parsed = JSON.parse(jsonStatus.stdout);
    assert.equal(parsed.node, `http://127.0.0.1:${port}`);
    assert.equal(parsed.mining, true);
    assert.equal(parsed.address, miner.address);
    assert.equal(typeof parsed.height, 'number');
    assert.equal(typeof parsed.difficulty, 'number');

    // --url reaches the same node without --port, the way a node on another
    // machine is addressed; a trailing slash is normalised away.
    const viaUrl = JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            cliPath,
            '--network',
            'devnet',
            'mining',
            'status',
            '--json',
            '--url',
            `http://127.0.0.1:${port}/`,
          ],
          { timeout: 10_000 },
        )
      ).stdout,
    );
    assert.equal(viaUrl.node, `http://127.0.0.1:${port}`);
    assert.equal(viaUrl.mining, true);
    assert.equal(viaUrl.address, miner.address);

    const duplicated = await promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        'mining',
        'status',
        '--url',
        `http://127.0.0.1:${port}`,
        '--port',
        String(port),
      ],
      { timeout: 10_000 },
    ).then(
      () => null,
      (error) => error,
    );
    assert.ok(duplicated, 'passing both --url and --port fails');
    assert.match(duplicated.stderr, /either --url or --port/);

    const badUrl = await promisify(execFile)(
      process.execPath,
      [
        cliPath,
        '--network',
        'devnet',
        'mining',
        'status',
        '--url',
        'ftp://example.com/node',
      ],
      { timeout: 10_000 },
    ).then(
      () => null,
      (error) => error,
    );
    assert.ok(badUrl, 'a non-http URL is rejected before any request');
    assert.match(badUrl.stderr, /--url must be a plain http\(s\) origin/);

    const paused = await mining(['pause']);
    assert.match(paused.stdout, /Mining paused/);
    assert.match(paused.stdout, /paused/);
    assert.equal((await state()).mining, false);

    // The JSON follows the node rather than repeating what it said last time.
    const pausedJson = JSON.parse((await mining(['status', '--json'])).stdout);
    assert.equal(pausedJson.mining, false);

    // Repeating it is harmless and says so.
    const again = await mining(['pause']);
    assert.match(again.stdout, /already paused/);
    assert.equal((await state()).mining, false);

    const resumed = await mining(['resume']);
    assert.match(resumed.stdout, /Mining resumed/);
    assert.equal((await state()).mining, true);

    const unknown = await mining(['slow']).then(
      () => null,
      (error) => error,
    );
    assert.ok(unknown, 'an unknown subcommand fails');
    assert.match(unknown.stderr, /usage: doubloom mining \[status\|pause\|resume\]/);

    // On a node with no payout address the API refusal is reported, not hidden.
    await node.close();
    node = startNode({
      chain: Chain.create(devnet),
      params: devnet,
      chainFile: path.join(dir, 'bare.json'),
      port: 0,
      minerAddress: null,
    });
    const bareDeadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < bareDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const barePort = node.server.address().port;
    const refused = await promisify(execFile)(
      process.execPath,
      [cliPath, '--network', 'devnet', 'mining', 'resume', '--port', String(barePort)],
      { timeout: 10_000 },
    ).then(
      () => null,
      (error) => error,
    );
    assert.ok(refused, 'resuming without an address fails');
    assert.match(refused.stderr, /no mining address/);
  } finally {
    if (node) {
      await node.close();
    }
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control endpoints answer on loopback, or with the token the node was given', async () => {
  const { controlRouteAllowed } = await import('../src/node.js');
  const remote = {
    method: 'POST',
    pathname: '/api/mining',
    remoteAddress: '203.0.113.7',
    authorization: undefined,
  };

  // What a peer needs is never a control route, so sync is unaffected.
  for (const [method, pathname] of [
    ['GET', '/api/info'],
    ['GET', '/api/chain'],
    ['GET', '/api/blocks'],
    ['GET', '/api/mempool'],
    ['GET', '/api/mining'],
    ['POST', '/api/tx'],
    ['POST', '/api/block'],
    ['POST', '/api/peers'],
    ['POST', '/api/reachability'],
  ]) {
    assert.equal(
      controlRouteAllowed({ ...remote, method, pathname }),
      true,
      `${method} ${pathname} stays open to peers`,
    );
  }

  // Everything that stops the miner, writes a backup or moves an archive is not.
  for (const [method, pathname] of [
    ['POST', '/api/mining'],
    ['POST', '/api/backup'],
    ['DELETE', '/api/backup/jobs/6d1f'],
    ['GET', '/api/backup/archives/doubloom-devnet-backup.json.gz'],
    ['GET', '/api/backup/download'],
  ]) {
    assert.equal(
      controlRouteAllowed({ ...remote, method, pathname }),
      false,
      `${method} ${pathname} needs the operator`,
    );
  }

  // Loopback is the operator: the CLI and the explorer both call from here.
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(controlRouteAllowed({ ...remote, remoteAddress }), true);
  }

  // A token holder may steer the node, but a backup copy is a separate
  // permission: the archives carry the wallet, so they stay put unless the
  // operator opted into remote downloads.
  const download = {
    method: 'GET',
    pathname: '/api/backup/download',
    remoteAddress: '203.0.113.7',
    authorization: 'Bearer s3cret',
  };
  assert.equal(controlRouteAllowed(download, 's3cret'), false);
  assert.equal(
    controlRouteAllowed(download, 's3cret', { allowRemoteDownloads: true }),
    true,
  );
  assert.equal(
    controlRouteAllowed(
      {
        ...download,
        pathname: '/api/backup/archives/doubloom-devnet-backup.json.gz',
      },
      's3cret',
    ),
    false,
  );
  assert.equal(
    controlRouteAllowed(
      { ...download, method: 'POST', pathname: '/api/mining' },
      's3cret',
      { allowRemoteDownloads: true },
    ),
    true,
    'the opt-in widens downloads only',
  );
  assert.equal(
    controlRouteAllowed(
      { ...download, remoteAddress: '127.0.0.1' },
      null,
      { allowRemoteDownloads: false },
    ),
    true,
  );

  // Anywhere else needs the token, and only the bearer scheme carries it.
  assert.equal(controlRouteAllowed(remote, 's3cret'), false, 'nothing presented');
  assert.equal(
    controlRouteAllowed({ ...remote, authorization: 'Bearer s3cret' }, 's3cret'),
    true,
  );
  assert.equal(
    controlRouteAllowed({ ...remote, authorization: 'bearer s3cret' }, 's3cret'),
    true,
    'the scheme is case-insensitive',
  );
  assert.equal(
    controlRouteAllowed({ ...remote, authorization: 'Bearer wrong' }, 's3cret'),
    false,
  );
  assert.equal(
    controlRouteAllowed({ ...remote, authorization: 'Bearer s3cret' }, null),
    false,
    'a token the node was not started with is not a credential',
  );
  assert.equal(
    controlRouteAllowed({ ...remote, authorization: 'Basic czNjcmV0' }, 's3cret'),
    false,
  );
});

test('a node beyond loopback serves peers but refuses controls without its token', async (t) => {
  const { startNode } = await import('../src/node.js');
  const address = externalIPv4();
  if (!address) {
    t.skip('this machine has no non-loopback IPv4 address to dial');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-control-'));
  const chainFile = path.join(dir, 'data', devnet.name, 'chain.json');
  const walletFile = path.join(dir, 'data', devnet.name, 'wallet.json');
  const chain = Chain.create(devnet);
  const wallet = Wallet.create(walletFile, devnet);
  saveChain(chain, chainFile);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  let node = null;
  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      walletFile,
      wallet,
      host: '0.0.0.0',
      port: 0,
      apiToken: 's3cret',
      mine: false,
      minerAddress: wallet.defaultKey().address,
      peers: [],
      seeds: [],
      logLevel: 'quiet',
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const base = `http://${address}:${node.server.address().port}`;
    const pause = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    };

    try {
      await fetch(`${base}/api/info`);
    } catch {
      t.skip(`this machine cannot dial its own address ${address}`);
      return;
    }

    assert.equal((await fetch(`${base}/api/info`)).status, 200, 'peers can read the node');
    assert.equal((await fetch(`${base}/api/mining`)).status, 200, 'status is not a control');

    const refused = await fetch(`${base}/api/mining`, pause);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /loopback/);

    const allowed = await fetch(`${base}/api/mining`, {
      ...pause,
      headers: { ...pause.headers, authorization: 'Bearer s3cret' },
    });
    assert.equal(allowed.status, 200);

    assert.equal((await fetch(`${base}/api/backup/download`)).status, 403);
    assert.ok(
      warnings.some((line) => /refused POST \/api\/mining/.test(line)),
      'a refused control request is logged',
    );

    // The token steers the node but does not carry the backup off it.
    const archive = await fetch(`${base}/api/backup/download`, {
      headers: { authorization: 'Bearer s3cret' },
    });
    assert.equal(archive.status, 403);
    assert.match((await archive.json()).error, /allow-remote-downloads/);
    assert.equal(
      (
        await fetch(`${base}/api/backup/archives/doubloom-devnet-1.json.gz`, {
          headers: { authorization: 'Bearer s3cret' },
        })
      ).status,
      403,
    );
  } finally {
    if (node) {
      await node.close();
    }
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a token holder reaches the archives only when the node allows remote downloads', async (t) => {
  const { startNode } = await import('../src/node.js');
  const address = externalIPv4();
  if (!address) {
    t.skip('this machine has no non-loopback IPv4 address to dial');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-downloads-'));
  const chainFile = path.join(dir, 'data', devnet.name, 'chain.json');
  const chain = Chain.create(devnet);
  saveChain(chain, chainFile);

  let node = null;
  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      host: '0.0.0.0',
      port: 0,
      apiToken: 's3cret',
      allowRemoteDownloads: true,
      mine: false,
      peers: [],
      seeds: [],
      logLevel: 'quiet',
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const base = `http://${address}:${node.server.address().port}`;

    let answered;
    try {
      answered = await fetch(`${base}/api/backup/download`, {
        headers: { authorization: 'Bearer s3cret' },
      });
    } catch {
      t.skip(`this machine cannot dial its own address ${address}`);
      return;
    }

    // Past the guard and into the handler: no schedule is running, so the
    // download is refused for that reason rather than for the address it came
    // from. That is what the opt-in buys.
    assert.equal(answered.status, 409);
    assert.match((await answered.json()).error, /not enabled/);

    // The token is still what lets it in at all.
    assert.equal((await fetch(`${base}/api/backup/download`)).status, 403);
  } finally {
    if (node) {
      await node.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a public node throttles transactions and peer announcements, but not loopback', async (t) => {
  const { startNode } = await import('../src/node.js');
  const address = externalIPv4();
  if (!address) {
    t.skip('this machine has no non-loopback IPv4 address to dial');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-throttle-'));
  const chainFile = path.join(dir, 'data', devnet.name, 'chain.json');
  const chain = Chain.create(devnet);
  saveChain(chain, chainFile);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  let node = null;
  try {
    node = startNode({
      chain,
      params: devnet,
      chainFile,
      host: '0.0.0.0',
      port: 0,
      mine: false,
      peers: [],
      seeds: [],
      logLevel: 'quiet',
    });
    const deadline = Date.now() + 3000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const port = node.server.address().port;
    const base = `http://${address}:${port}`;
    const post = (route, body) =>
      fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    let first;
    try {
      first = await post('/api/tx', {});
    } catch {
      t.skip(`this machine cannot dial its own address ${address}`);
      return;
    }
    // An empty object is rejected as a transaction, which is what makes this
    // cheap to send: the limiter counts attempts, not successes.
    assert.equal(first.status, 400);
    for (let attempt = 1; attempt < 60; attempt += 1) {
      assert.equal((await post('/api/tx', {})).status, 400);
    }
    const throttled = await post('/api/tx', {});
    assert.equal(throttled.status, 429);
    assert.ok(
      Number(throttled.headers.get('retry-after')) >= 1,
      'a throttled caller is told when to come back',
    );
    assert.match((await throttled.json()).error, /too many tx requests/);

    // Peer announcements have their own allowance.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal((await post('/api/peers', { peer: 'not a url' })).status, 200);
    }
    assert.equal((await post('/api/peers', { peer: 'not a url' })).status, 429);

    // This machine is the operator: the CLI and the explorer are never
    // throttled, however loud the same machine is over its LAN address.
    const local = await fetch(`http://127.0.0.1:${port}/api/tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(local.status, 400);
    assert.ok(
      warnings.some((line) => /throttled tx requests from/.test(line)),
      'throttling is logged',
    );
  } finally {
    if (node) {
      await node.close();
    }
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coinbase transactions are recognized', () => {

  const coinbase = createCoinbase({
    height: 5,
    value: 50n * COIN,
    address: 'D'.padEnd(34, '1'),
  });
  assert.ok(isCoinbase(coinbase));
  assert.equal(coinbase.inputs[0].height, 5);
});
