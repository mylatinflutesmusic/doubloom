#!/usr/bin/env node
/**
 * Chain-growth benchmark.
 *
 * Measures what a longer chain costs: the cached cumulative work read, the cost
 * of rebuilding that total from the headers, and how long `GET /api/info` takes
 * on a real node — at several heights, on a real chain.
 *
 *   node bench/growth.js [--heights 1000,10000,50000] [--samples 25]
 *
 * The chain is devnet and is grown by actually mining blocks in this process,
 * with the node answering requests while it grows. Mining is normally the
 * limiting factor, so the block clock is chosen to keep the difficulty at the
 * network's genesis floor; see `growTo` for why that needs a compensating gap
 * pattern rather than even spacing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Chain, cumulativeWork } from '../src/chain.js';
import { mineHeader } from '../src/block.js';
import { networkParams } from '../src/params.js';
import { Wallet } from '../src/wallet.js';
import { startNode } from '../src/node.js';

const DEFAULT_HEIGHTS = [1_000, 10_000, 50_000];
const DEFAULT_SAMPLES = 25;

function usage() {
  console.log(`
Chain-growth benchmark for Doubloom.

  node bench/growth.js [options]

  --heights <list>   Comma-separated heights to sample (default
                     ${DEFAULT_HEIGHTS.join(',')})
  --samples <count>  /api/info requests per height (default ${DEFAULT_SAMPLES})
  --help             Show this message

The chain is grown on devnet by real proof-of-work, so the run costs roughly a
second per 3,000 blocks; a node serves /api/info from the same chain meanwhile.
`);
}

function parseArgs(argv) {
  const options = { heights: [...DEFAULT_HEIGHTS], samples: DEFAULT_SAMPLES };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--heights' || argument === '--samples') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;

      if (argument === '--samples') {
        const samples = Number(value);
        if (!Number.isInteger(samples) || samples < 1) {
          throw new Error('--samples must be a positive integer');
        }
        options.samples = samples;
        continue;
      }

      const heights = value.split(',').map((entry) => Number(entry.trim()));
      if (
        heights.length === 0 ||
        heights.some((height) => !Number.isInteger(height) || height < 1)
      ) {
        throw new Error('--heights must be a comma-separated list of positive integers');
      }
      options.heights = [...new Set(heights)].sort((left, right) => left - right);
      continue;
    }
    throw new Error(`unknown option "${argument}"`);
  }

  return options;
}

/** One call, or enough calls to fill `minMs`, reported as milliseconds each. */
function timePerCall(fn, { minMs = 25, maxIterations = 200_000 } = {}) {
  fn();
  const seedStart = process.hrtime.bigint();
  fn();
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;
  const iterations = Math.min(
    maxIterations,
    Math.max(1, Math.ceil(minMs / Math.max(seedMs, 1e-6))),
  );

  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    fn();
  }
  return Number(process.hrtime.bigint() - started) / iterations / 1e6;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

/**
 * Block gaps that keep the difficulty where it started.
 *
 * A retarget compares the span between the first and last block of its window
 * with `retargetInterval * targetBlockTime`. That window holds
 * `retargetInterval - 1` gaps, not `retargetInterval`, so spacing blocks at
 * exactly the target block time makes every retarget see a span one gap short
 * and raise the difficulty by that fraction. On devnet (20 blocks, 60 s) that is
 * 5% per retarget, which compounds to a chain nobody can mine.
 *
 * Instead, the gaps repeat a pattern whose total is exactly one window's
 * expected span. Every window is then a rotation of that pattern, so the ratio
 * is exactly 1 at every retarget and the difficulty stays at the genesis floor.
 */
export function steadyGaps(params) {
  const window = params.retargetInterval - 1;
  const expected = params.retargetInterval * params.targetBlockTime;
  const base = Math.floor(expected / window);
  const extra = expected - base * window;
  return Array.from({ length: window }, (_, index) =>
    index < extra ? base + 1 : base,
  );
}

function formatHeight(height) {
  return height.toLocaleString('en-US');
}

function formatMilliseconds(value) {
  return `${value.toFixed(4)} ms`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const params = networkParams('devnet');
  const gaps = steadyGaps(params);
  const gapTotal = gaps.reduce((sum, gap) => sum + gap, 0);
  const averageGap = gapTotal / gaps.length;
  const futureLimit = Math.floor(Date.now() / 1000) + 7200;
  const maxHeight = Math.floor((futureLimit - params.genesisTime) / averageGap);
  const tallest = options.heights[options.heights.length - 1];
  if (tallest > maxHeight) {
    throw new Error(
      `--heights cannot exceed ${formatHeight(maxHeight)}: past that, block timestamps would be rejected as too far in the future`,
    );
  }

  const wallet = new Wallet('bench-wallet.json', params);
  const miner = wallet.newKey('bench');
  const chain = Chain.create(params);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-bench-'));
  const chainFile = path.join(directory, 'chain.json');

  // The node narrates its startup on the listening event, so it stays muted
  // until that has happened; the benchmark's own output is the report.
  const realLog = console.log;
  let node = null;
  try {
    console.log = () => {};
    node = startNode({ chain, params, chainFile, port: 0 });
    const deadline = Date.now() + 5000;
    while (!node.server.address() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log = realLog;
    if (!node.server.address()) {
      throw new Error('the benchmark node did not start listening');
    }
    const base = `http://127.0.0.1:${node.server.address().port}`;

    console.log(`\nDoubloom chain-growth benchmark (${params.name})\n`);
    console.log(
      `  blocks are mined ${averageGap.toFixed(2)}s apart on average, which holds difficulty at 0x${params.genesisBits.toString(16)}`,
    );
    console.log('  work cached   = chain.work, maintained beside the blocks');
    console.log('  work rebuild  = cumulativeWork(blocks), what a fresh total costs');
    console.log('  info          = GET /api/info round trip on the local node');

    let nextTime = params.genesisTime;
    const rows = [];

    for (const height of options.heights) {
      const started = process.hrtime.bigint();
      while (chain.height < height) {
        const next = chain.height + 1;
        const block = chain.buildBlock(miner.address);
        // The gap pattern sets the clock, so `buildBlock`'s wall-clock time is
        // replaced; the nonce is then mined again over the new header.
        nextTime += gaps[(next - 1) % gaps.length];
        block.header.time = nextTime;
        mineHeader(block.header);
        chain.addBlock(block);
      }
      const minedMs = Number(process.hrtime.bigint() - started) / 1e6;

      if (chain.tip.header.bits !== params.genesisBits) {
        throw new Error(
          `difficulty drifted to 0x${chain.tip.header.bits.toString(16)} at height ${height}; the benchmark's clock pattern is wrong`,
        );
      }

      const cachedWorkMs = timePerCall(() => chain.work);
      const rebuildMs = timePerCall(() => cumulativeWork(chain.blocks));

      // Warm the connection, the route and the JSON path, then measure the
      // endpoint itself; the first requests on a fresh socket are much slower
      // and would otherwise be read as a chain-length effect. Mining just
      // before this leaves garbage behind, so give the collector a moment too.
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (let index = 0; index < 20; index += 1) {
        await (await fetch(`${base}/api/info`)).json();
      }
      const latencies = [];
      for (let index = 0; index < options.samples; index += 1) {
        const requestStart = process.hrtime.bigint();
        const response = await fetch(`${base}/api/info`);
        await response.json();
        latencies.push(Number(process.hrtime.bigint() - requestStart) / 1e6);
      }

      rows.push({
        height,
        minedMs,
        cachedWorkMs,
        rebuildMs,
        infoP50: percentile(latencies, 0.5),
        infoP95: percentile(latencies, 0.95),
        work: chain.work,
      });
    }

    const header = ['height', 'mined', 'work cached', 'work rebuild', 'info p50', 'info p95'];
    const widths = [10, 8, 13, 13, 10, 10];
    console.log(
      `\n  ${header
        .map((label, index) => label.padStart(widths[index]))
        .join('  ')}`,
    );
    for (const row of rows) {
      const cells = [
        formatHeight(row.height),
        `${(row.minedMs / 1000).toFixed(1)}s`,
        formatMilliseconds(row.cachedWorkMs),
        formatMilliseconds(row.rebuildMs),
        `${row.infoP50.toFixed(2)} ms`,
        `${row.infoP95.toFixed(2)} ms`,
      ];
      console.log(
        `  ${cells.map((cell, index) => cell.padStart(widths[index])).join('  ')}`,
      );
    }

    const finalRow = rows[rows.length - 1];
    const info = await (await fetch(`${base}/api/info`)).json();
    console.log(
      `\n  at height ${formatHeight(finalRow.height)}: chain work ${info.work}, difficulty ${info.difficulty}, tip ${info.bestBlockHash.slice(0, 16)}…`,
    );
    console.log(
      `  ${info.work === finalRow.work.toString() ? 'the node reports the same total the benchmark measured' : 'WARNING: the node reports a different work total'}`,
    );
    // The floor difficulty keeps each header's work at one unit, so this total
    // is linear in height. It is the timings above that the run is for.
    console.log(
      `  difficulty is pinned at the genesis floor, so one unit of work per block; rebuilding the total at this height costs ${finalRow.rebuildMs.toFixed(2)} ms against a cached read of ${finalRow.cachedWorkMs.toFixed(4)} ms\n`,
    );
  } finally {
    console.log = realLog;
    await node?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Importable for its clock pattern without running a benchmark.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(`\nbenchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
