import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Chain } from './chain.js';
import { Wallet } from './wallet.js';
import { loadChain } from './store.js';
import { headerHash } from './block.js';

/**
 * A node backup is a single gzip-compressed JSON archive containing a verified
 * chain snapshot and the encrypted wallet. Mempool entries are deliberately
 * omitted: they are not part of the ledger, may expire, and should not reappear
 * as pending after a restore. The chain is public; the wallet stays encrypted
 * under its own passphrase, so the archive never contains readable private
 * keys. Compression is transparent on restore, including for archives written
 * before it existed.
 */

export const NODE_BACKUP_FORMAT = 'doubloom-node-backup';
export const NODE_BACKUP_VERSION = 1;

/**
 * How many blocks one progress step covers. Writing and verifying are both
 * per-block, so a caller can say how far through the chain it is; reporting
 * every block would post a message per block on a long chain for a bar that
 * only moves a fraction of a percent.
 */
const PROGRESS_BLOCKS = 250;

function readArchive(source) {
  if (!fs.existsSync(source)) {
    throw new Error(`no backup at ${source}`);
  }
  let buffer;
  try {
    buffer = fs.readFileSync(source);
  } catch (error) {
    throw new Error(`could not read backup at ${source}: ${error.message}`);
  }

  // gzip magic: new archives are compressed, older ones are plain JSON. Both
  // forms are accepted so existing backups stay restorable.
  let text;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      text = zlib.gunzipSync(buffer).toString('utf8');
    } catch (error) {
      throw new Error(
        `backup at ${source} could not be decompressed: ${error.message}`,
      );
    }
  } else {
    text = buffer.toString('utf8');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`backup at ${source} is not valid JSON`);
  }
}

/**
 * Load the archived wallet through a temporary file so it goes through exactly
 * the same validation as a real wallet, then decrypt every key.
 */
function verifyArchivedWallet(params, walletData, passphrase) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubloom-backup-'));
  try {
    const file = path.join(directory, 'wallet.json');
    fs.writeFileSync(file, JSON.stringify(walletData, null, 2), { mode: 0o600 });
    const wallet = Wallet.load(file, params);
    if (!wallet) {
      throw new Error('backup wallet is empty');
    }
    if (!wallet.isEncrypted) {
      throw new Error(
        'backup wallet is not encrypted; refusing to restore plaintext keys',
      );
    }
    wallet.unlock(passphrase);
    return wallet;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verifyArchive(params, archive, passphrase, onBlock) {
  if (!archive || typeof archive !== 'object') {
    throw new Error('backup is empty or not an object');
  }
  if (archive.format !== NODE_BACKUP_FORMAT) {
    throw new Error('file is not a Doubloom node backup');
  }
  if (archive.version !== NODE_BACKUP_VERSION) {
    throw new Error(`unsupported backup version ${archive.version}`);
  }
  if (typeof archive.network !== 'string') {
    throw new Error('backup is missing its network');
  }
  if (archive.network !== params.name) {
    throw new Error(
      `backup belongs to the ${archive.network} network, not ${params.name}`,
    );
  }
  if (
    !archive.chain ||
    archive.chain.version !== 1 ||
    archive.chain.network !== params.name ||
    !Array.isArray(archive.chain.blocks)
  ) {
    throw new Error('backup is missing a valid chain snapshot');
  }
  if (!archive.wallet || typeof archive.wallet !== 'object') {
    throw new Error('backup is missing its wallet');
  }

  // The Chain constructor replays every block: proof of work, merkle roots,
  // transaction signatures, subsidies and the UTXO set are all checked here.
  const chain = new Chain(params, archive.chain.blocks, onBlock);
  const wallet = verifyArchivedWallet(params, archive.wallet, passphrase);

  const height = chain.height;
  const tip = headerHash(chain.tip.header);
  const addresses = wallet.listKeys().map((key) => key.address);
  const summary = archive.summary;
  const summaryMatches =
    summary &&
    summary.height === height &&
    summary.tip === tip &&
    Array.isArray(summary.addresses) &&
    summary.addresses.length === addresses.length &&
    summary.addresses.every((address, index) => address === addresses[index]);

  if (!summaryMatches) {
    throw new Error('backup summary does not match its chain and wallet');
  }

  return { chain, wallet, height, tip, addresses };
}

/**
 * Write a node backup and verify it by reading the finished file back,
 * replaying its chain and decrypting its wallet.
 */
/**
 * The block array of the archive as text, in chunks, so a caller can report how
 * much of the chain has been serialized. Joining the chunks is exactly what one
 * `JSON.stringify(blocks)` produces: an array's serialization is its elements
 * separated by commas.
 */
function serializeBlocks(blocks, onChunk) {
  if (blocks.length === 0) {
    return '[]';
  }
  const parts = [];
  for (let index = 0; index < blocks.length; index += PROGRESS_BLOCKS) {
    parts.push(
      JSON.stringify(blocks.slice(index, index + PROGRESS_BLOCKS)).slice(1, -1),
    );
    onChunk?.(Math.min(index + PROGRESS_BLOCKS, blocks.length));
  }
  return `[${parts.join(',')}]`;
}

export function createNodeBackup({
  params,
  chainFile,
  walletFile,
  destination,
  passphrase,
  createdAt = new Date().toISOString(),
  onProgress,
}) {
  const wallet = Wallet.load(walletFile, params);
  if (!wallet) {
    throw new Error(`no wallet at ${walletFile}`);
  }
  if (!wallet.isEncrypted) {
    throw new Error(
      'wallet is not encrypted; run "doubloom wallet lock" before backing up the node',
    );
  }
  wallet.unlock(passphrase);

  const chain = loadChain(params, chainFile);
  if (!chain) {
    throw new Error(`no chain at ${chainFile}`);
  }

  const blocks = chain.blocks;
  const total = blocks.length;
  // Writing fills the first half of the bar and verifying the second: both are
  // per block, and the gap between them is the gzip and the file write, which
  // have no block to count.
  const report = (phase, done) => {
    if (!onProgress) {
      return;
    }
    const fraction = total > 0 ? Math.min(1, done / total) : 1;
    const percent =
      phase === 'writing'
        ? Math.round(fraction * 50)
        : 50 + Math.round(fraction * 50);
    onProgress({ phase, done, total, percent });
  };

  report('writing', 0);
  // The archive is assembled around the block array so the array can be written
  // in chunks: the rest is one object, serialized in the same key order, and the
  // placeholder is replaced with exactly the text `JSON.stringify(blocks)`
  // would have produced.
  const template = {
    format: NODE_BACKUP_FORMAT,
    version: NODE_BACKUP_VERSION,
    network: params.name,
    createdAt,
    summary: {
      height: chain.height,
      tip: headerHash(chain.tip.header),
      addresses: wallet.listKeys().map((key) => key.address),
    },
    chain: {
      version: 1,
      network: params.name,
      blocks: '<blocks>',
      mempool: [],
    },
    wallet: wallet.data,
  };
  const blocksJson = serializeBlocks(blocks, (done) => report('writing', done));
  // A function replacer, so `$&`-style sequences in block data stay literal.
  const text = JSON.stringify(template).replace('"<blocks>"', () => blocksJson);
  const compressed = zlib.gzipSync(Buffer.from(text));
  // Name the file for what it is, and keep a caller-supplied .gz suffix as is.
  const file = destination.endsWith('.gz') ? destination : `${destination}.gz`;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, compressed, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`backup file already exists: ${file}`);
    }
    fs.rmSync(file, { force: true });
    throw error;
  }

  // The write is complete: the chain is all in the file, and what remains is
  // reading it back, decrypting the wallet and replaying every block.
  report('writing', total);
  let lastVerified = 0;
  const verifying = (done) => {
    if (done !== total && done - lastVerified < PROGRESS_BLOCKS) {
      return;
    }
    lastVerified = done;
    report('verifying', done);
  };

  try {
    const written = readArchive(file);
    const verified = verifyArchive(params, written, passphrase, verifying);
    // The file's last write is when the archive finished being written, taken
    // now rather than read later: a copy or a restore may move the mtime, but
    // what this run did does not change. Verification follows, so this is the
    // write, not the whole job.
    const stats = fs.statSync(file);
    return {
      path: file,
      bytes: stats.size,
      writtenAt: stats.mtime.toISOString(),
      rawBytes: Buffer.byteLength(text),
      height: verified.height,
      tip: verified.tip,
      keys: verified.addresses.length,
      addresses: verified.addresses,
    };
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw new Error(`backup verification failed: ${error.message}`);
  }
}

/**
 * Validate a node backup, then install its chain and wallet. Nothing is
 * written until the whole archive has passed verification, and an existing
 * chain or wallet is only replaced when `force` is set.
 */
export function restoreNodeBackup({
  source,
  params,
  chainFile,
  walletFile,
  passphrase,
  force = false,
}) {
  const archive = readArchive(source);
  const verified = verifyArchive(params, archive, passphrase);

  const existing = [chainFile, walletFile].filter((file) => fs.existsSync(file));
  if (existing.length > 0 && !force) {
    throw new Error(
      `node data already exists at ${existing.join(' and ')}; move it aside or pass --force to overwrite it`,
    );
  }

  const chainText = JSON.stringify({
    version: 1,
    network: params.name,
    blocks: archive.chain.blocks,
    mempool: [],
  });
  const walletText = JSON.stringify(archive.wallet, null, 2);

  fs.mkdirSync(path.dirname(chainFile), { recursive: true });
  fs.mkdirSync(path.dirname(walletFile), { recursive: true });
  const chainTemporary = `${chainFile}.restore.tmp`;
  const walletTemporary = `${walletFile}.restore.tmp`;

  try {
    fs.writeFileSync(chainTemporary, chainText);
    fs.writeFileSync(walletTemporary, walletText, { mode: 0o600 });
    fs.renameSync(chainTemporary, chainFile);
    fs.renameSync(walletTemporary, walletFile);
  } catch (error) {
    fs.rmSync(chainTemporary, { force: true });
    fs.rmSync(walletTemporary, { force: true });
    throw error;
  }

  return {
    chainFile,
    walletFile,
    height: verified.height,
    tip: verified.tip,
    keys: verified.addresses.length,
    addresses: verified.addresses,
  };
}
