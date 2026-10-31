#!/usr/bin/env node
/**
 * CPU hashrate benchmark for Doubloom's proof-of-work.
 *
 * Measures how many 80-byte block headers this machine can hash while searching
 * for a nonce, then turns that rate into the figures that actually decide
 * whether mining is worth doing: the expected time to find a block on Bitcoin's
 * network, the pool payout that share earns in a day, what the same hours cost
 * in electricity, and the coin price that would be needed to break even.
 *
 *   node bench/hashrate.js [options]
 *
 *   --seconds <n>            How long to measure each loop (default 2)
 *   --network-hashrate <eh>  Bitcoin's network hashrate in EH/s (default 800)
 *   --watts <n>              Power draw of the machine while mining (default 95)
 *   --kwh <price>            Electricity price per kWh in USD (default 0.15)
 *
 * Two loops are measured. The first hashes exactly the way this project's miner
 * does — `headerHash()` rebuilds the 80-byte header and returns hex, and the
 * result is compared as a BigInt — so it is the rate a Doubloom node would
 * actually reach on this hardware. The second keeps the same SHA-256d but
 * writes the nonce into a reused buffer and compares the digest bytes directly,
 * which is what a miner tuned in JavaScript can manage. Neither is close to a
 * C or CUDA miner, and neither is within orders of magnitude of an ASIC.
 *
 * The network figures are inputs, not measurements: --network-hashrate defaults
 * to a snapshot of Bitcoin's hashrate, and the subsidy assumes the 3.125 BTC
 * block reward in force since the 2024 halving. Pass current values to get
 * meaningful output.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { bitsToTarget, headerHash } from '../src/block.js';
import { sha256d } from '../src/hash.js';
import { networkParams } from '../src/params.js';

const SECONDS_PER_BLOCK = 600;
const BLOCKS_PER_DAY = (24 * 60 * 60) / SECONDS_PER_BLOCK;
const SUBSIDY = 3.125; // BTC per block since the 2024 halving
const ASIC_HASHRATE = 200e12; // one current-generation air-cooled ASIC, H/s

const DEFAULTS = {
  seconds: 2,
  networkHashrateEh: 800,
  watts: 95,
  kwh: 0.15,
};

function usage() {
  console.log(`
CPU hashrate benchmark for Doubloom.

  node bench/hashrate.js [options]

  --seconds <n>            Seconds to measure each loop (default ${DEFAULTS.seconds})
  --network-hashrate <eh>  Bitcoin network hashrate in EH/s (default ${DEFAULTS.networkHashrateEh})
  --watts <n>              Power draw while mining (default ${DEFAULTS.watts})
  --kwh <price>            Electricity price per kWh, USD (default ${DEFAULTS.kwh})
  --help                   Show this message

The loops are measured here, on this machine. The network hashrate and the
subsidy are assumptions, so replace them with current figures.
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    const flags = {
      '--seconds': 'seconds',
      '--network-hashrate': 'networkHashrateEh',
      '--watts': 'watts',
      '--kwh': 'kwh',
    };
    const key = flags[argument];
    if (!key) {
      throw new Error(`unknown option "${argument}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;

    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`${argument} must be a positive number`);
    }
    options[key] = number;
  }

  return options;
}

/** Group a count for reading; hashrates span nine orders of magnitude here. */
function group(value) {
  return Math.round(value).toLocaleString('en-US');
}

function formatRate(hashrate) {
  const units = [
    [1e18, 'EH/s'],
    [1e15, 'PH/s'],
    [1e12, 'TH/s'],
    [1e9, 'GH/s'],
    [1e6, 'MH/s'],
    [1e3, 'kH/s'],
  ];
  for (const [scale, unit] of units) {
    if (hashrate >= scale) {
      return `${(hashrate / scale).toFixed(hashrate / scale >= 100 ? 0 : 1)} ${unit}`;
    }
  }
  return `${group(hashrate)} H/s`;
}

/** Durations from milliseconds to eons, which is where CPU mining lands. */
function formatDuration(seconds) {
  const units = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [365, 'day'],
    [1000, 'year'],
    [1000, 'thousand years'],
    [1000, 'million years'],
    [1000, 'billion years'],
  ];

  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(1)} ms`;
  }

  let value = seconds;
  let index = 0;
  while (index < units.length - 1 && value >= units[index][0]) {
    value /= units[index][0];
    index += 1;
  }
  const [scale, name] = units[index];
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${name}${value === 1 ? '' : index === 0 ? 's' : ''}`;
}

/**
 * Run `step(hashCount)` in chunks until `seconds` have passed.
 *
 * Time is checked between chunks rather than per hash, so the measurement does
 * not itself dominate the loop, and the reported rate uses the elapsed time
 * actually measured rather than the requested duration.
 */
function measure(step, { seconds, chunk = 20_000 }) {
  step(chunk); // warm up: let the JIT see the loop before timing it
  const started = process.hrtime.bigint();
  let hashes = 0;
  while (Number(process.hrtime.bigint() - started) / 1e9 < seconds) {
    step(chunk);
    hashes += chunk;
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  return { hashes, elapsed, hashrate: hashes / elapsed };
}

/**
 * The node's own loop: rebuild the header, hash it, compare as a BigInt.
 *
 * This is `mineHeader()` in src/block.js without the nonce wraparound, kept
 * honest so the rate below is the one a Doubloom node actually mines at.
 */
function measureNodeLoop(seconds) {
  const params = networkParams('devnet');
  const header = {
    version: 1,
    prevHash: '00'.repeat(32),
    merkleRoot: '11'.repeat(32),
    time: params.genesisTime,
    bits: params.genesisBits,
    nonce: 0,
  };
  const target = bitsToTarget(header.bits);

  let found = 0;
  const result = measure(
    (count) => {
      for (let index = 0; index < count; index += 1) {
        header.nonce = (header.nonce + 1) >>> 0;
        if (BigInt(`0x${headerHash(header)}`) <= target) {
          found += 1;
        }
      }
    },
    { seconds },
  );

  return { ...result, found };
}

/**
 * A tuned JavaScript loop: the header buffer is built once and the nonce is
 * written into it, and the digest is compared byte-wise against the target
 * instead of being encoded as hex and parsed as a BigInt.
 */
function measureTunedLoop(seconds) {
  const params = networkParams('devnet');
  const header = Buffer.alloc(80);
  header.writeUInt32LE(1, 0);
  Buffer.from('00'.repeat(32), 'hex').copy(header, 4);
  Buffer.from('11'.repeat(32), 'hex').copy(header, 36);
  header.writeUInt32LE(params.genesisTime, 68);
  header.writeUInt32LE(params.genesisBits, 72);

  // A 32-byte big-endian target, so a lexicographic digest comparison is the
  // same test as `BigInt(hex) <= target`.
  const target = bitsToTarget(params.genesisBits);
  const targetBytes = Buffer.from(target.toString(16).padStart(64, '0'), 'hex');

  let nonce = 0;
  let found = 0;
  const result = measure(
    (count) => {
      for (let index = 0; index < count; index += 1) {
        header.writeUInt32LE(nonce >>> 0, 76);
        if (sha256d(header).compare(targetBytes) <= 0) {
          found += 1;
        }
        nonce = (nonce + 1) >>> 0;
      }
    },
    { seconds },
  );

  return { ...result, found };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const networkHashrate = options.networkHashrateEh * 1e18;

  const nodeLoop = measureNodeLoop(options.seconds);
  const tunedLoop = measureTunedLoop(options.seconds);

  // The tuned loop is the optimistic CPU number; everything below is derived
  // from it, so the report never flatters the plan by overstating the hardware.
  const hashrate = tunedLoop.hashrate;
  const shareOfNetwork = hashrate / networkHashrate;
  const secondsPerBlock = SECONDS_PER_BLOCK / shareOfNetwork;
  const btcPerDay = shareOfNetwork * BLOCKS_PER_DAY * SUBSIDY;
  const kwhPerDay = (options.watts / 1000) * 24;
  const costPerDay = kwhPerDay * options.kwh;
  const breakEvenPrice = costPerDay / btcPerDay;

  console.log('\nDoubloom hashrate benchmark · SHA-256d over an 80-byte header\n');
  console.log(`  machine        ${os.cpus().length} × ${os.cpus()[0].model.trim()}`);
  console.log(`  measured for   ${options.seconds}s per loop\n`);
  console.log(
    `  node's miner   ${formatRate(nodeLoop.hashrate).padStart(9)}   (${group(nodeLoop.hashes)} hashes in ${nodeLoop.elapsed.toFixed(2)}s)`,
  );
  console.log(
    `  tuned loop     ${formatRate(tunedLoop.hashrate).padStart(9)}   (${group(tunedLoop.hashes)} hashes in ${tunedLoop.elapsed.toFixed(2)}s)`,
  );
  console.log(
    `  tuned vs node  ${(tunedLoop.hashrate / nodeLoop.hashrate).toFixed(1)}×   the miner spends its time rebuilding the header and parsing hex`,
  );

  console.log('\nWhat that rate is worth against Bitcoin\n');
  console.log(
    `  network        ${formatRate(networkHashrate)} assumed, so one block every 10 minutes network-wide`,
  );
  console.log(
    `  your share     ${shareOfNetwork.toExponential(2)} of the network's hashing power`,
  );
  console.log(
    `  one ASIC is    ${group(ASIC_HASHRATE / hashrate)}× this machine, so ${group(networkHashrate / ASIC_HASHRATE)} ASICs equal the network`,
  );
  console.log(
    `  solo block     ${formatDuration(secondsPerBlock)} on average — you will not mine one`,
  );
  console.log(
    `  in a pool      ${btcPerDay.toExponential(2)} BTC per day at ${options.watts} W and $${options.kwh}/kWh`,
  );
  console.log(
    `  power costs    $${costPerDay.toFixed(2)} per day (${kwhPerDay.toFixed(1)} kWh)`,
  );
  console.log(
    `  verdict        BTC would have to trade at $${group(breakEvenPrice)} for this machine to cover its electricity; below that, mining is a loss`,
  );
  console.log('');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    console.error(`\nbenchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
