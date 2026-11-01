import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  addressFromPublicKey,
  decodeAddress,
  generateKeyPair,
  publicKeyFromPrivateKey,
} from './keys.js';
import { formatAmount, parseAmount } from './amount.js';
import { signInput, txSize, txid } from './transaction.js';
import {
  createEncryption,
  decryptPrivateKey,
  deriveKey,
  encryptPrivateKey,
} from './wallet-crypto.js';

function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * When the export at `file` was written, as an ISO timestamp.
 *
 * A wallet backup is a gzip of the wallet, and gzip's header has a standard
 * MTIME field (bytes 4-7, little endian). The export time is written there, so
 * the stamp travels with the file's bytes and survives being copied to another
 * machine — which resets the file's own times. Exports written before this was
 * recorded carry zero in that field; those fall back to the file's modification
 * time, which is when the archive was written until something copies it without
 * preserving times. Plain-JSON exports from before compression fall back the
 * same way.
 */
export function backupArchiveTime(file) {
  const stored = fs.readFileSync(file);
  if (isGzip(stored) && stored.length >= 8) {
    const seconds = stored.readUInt32LE(4);
    if (seconds > 0) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return fs.statSync(file).mtime.toISOString();
}

/**
 * Read a wallet or wallet backup as plain JSON bytes, decompressing on the way.
 * Backups written before compression existed are plain JSON and still load, so
 * an old export restores with the current code.
 */
function readWalletBytes(file) {
  const stored = fs.readFileSync(file);
  if (!isGzip(stored)) {
    return { bytes: stored, compressed: false };
  }
  return { bytes: zlib.gunzipSync(stored), compressed: true };
}

/**
 * A wallet is a JSON file of independent secp256k1 keypairs. Doubloom has no
 * HD wallet: every address is its own key.
 *
 * Version 1 stores private keys as plaintext. Version 2 stores the public
 * metadata (address, public key, label) in the clear and each private key
 * encrypted with AES-256-GCM under a key derived from the wallet passphrase.
 * Addresses and balances therefore remain available while the wallet is
 * locked; only signing requires unlocking.
 */
export class Wallet {
  constructor(file, params) {
    this.file = file;
    this.params = params;
    this.data = { version: 1, network: params.name, keys: [] };
    this.masterKey = null;
    this.privateKeys = new Map();
  }

  static load(file, params) {
    if (!fs.existsSync(file)) {
      return null;
    }

    const data = JSON.parse(readWalletBytes(file).bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.keys)) {
      throw new Error(`wallet at ${file} is not a valid wallet file`);
    }
    if (data.network !== params.name) {
      throw new Error(`wallet at ${file} belongs to the ${data.network} network`);
    }

    const version = data.version ?? 1;
    if (version > 2) {
      throw new Error(`wallet at ${file} uses an unsupported version`);
    }
    if (version === 2) {
      if (!data.crypto) {
        throw new Error('encrypted wallet is missing its encryption parameters');
      }
      if (data.keys.some((entry) => typeof entry.privateKey === 'string')) {
        throw new Error('encrypted wallet unexpectedly contains plaintext keys');
      }
    }

    const wallet = new Wallet(file, params);
    wallet.data = data;
    return wallet;
  }

  static create(file, params, label = 'primary') {
    const wallet = new Wallet(file, params);
    wallet.newKey(label);
    wallet.save();
    return wallet;
  }

  get isEncrypted() {
    return Boolean(this.data.crypto);
  }

  get isUnlocked() {
    return this.masterKey !== null;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }

  additionalData(address) {
    return `${this.params.name}:${address}`;
  }

  newKey(label = '') {
    if (this.isEncrypted && !this.isUnlocked) {
      throw new Error('wallet is locked; unlock it before adding a key');
    }

    const { privateKey, publicKey } = generateKeyPair();
    const address = addressFromPublicKey(publicKey, this.params.addressVersion);
    const entry = {
      address,
      publicKey,
      label,
      createdAt: new Date().toISOString(),
    };

    if (this.isEncrypted) {
      entry.encryptedPrivateKey = encryptPrivateKey(
        privateKey,
        this.masterKey,
        this.additionalData(address),
      );
      this.privateKeys.set(address, privateKey);
    } else {
      entry.privateKey = privateKey;
    }

    this.data.keys.push(entry);
    return entry;
  }

  /** Return the private key for an address, or explain why it is unavailable. */
  privateKeyFor(address) {
    const entry = this.findKey(address);
    if (!entry) {
      throw new Error(`no key for ${address} in this wallet`);
    }
    if (typeof entry.privateKey === 'string') {
      return entry.privateKey;
    }
    const secret = this.privateKeys.get(address);
    if (!secret) {
      throw new Error(
        'wallet is locked; enter its passphrase or run "doubloom wallet unlock"',
      );
    }
    return secret;
  }

  /** Encrypt every private key with a new passphrase and save the wallet. */
  encrypt(passphrase) {
    if (this.isEncrypted) {
      throw new Error('wallet is already encrypted');
    }
    for (const entry of this.data.keys) {
      if (typeof entry.privateKey !== 'string') {
        throw new Error(`wallet key ${entry.address} is missing its private key`);
      }
    }

    const { crypto, key } = createEncryption(passphrase);
    const secrets = new Map();

    for (const entry of this.data.keys) {
      secrets.set(entry.address, entry.privateKey);
      entry.encryptedPrivateKey = encryptPrivateKey(
        entry.privateKey,
        key,
        this.additionalData(entry.address),
      );
      delete entry.privateKey;
    }

    this.data.version = 2;
    this.data.crypto = crypto;
    this.masterKey = key;
    this.privateKeys = secrets;
    this.save();
  }

  /** Derive the key and decrypt everything into memory only. */
  unlock(passphrase) {
    if (!this.isEncrypted || this.isUnlocked) {
      return;
    }

    const key = deriveKey(passphrase, this.data.crypto);
    const secrets = new Map();

    for (const entry of this.data.keys) {
      if (!entry.encryptedPrivateKey || typeof entry.publicKey !== 'string') {
        throw new Error('wallet file is corrupted');
      }
      const privateKey = decryptPrivateKey(
        entry.encryptedPrivateKey,
        key,
        this.additionalData(entry.address),
      );

      let derivedPublicKey;
      try {
        derivedPublicKey = publicKeyFromPrivateKey(privateKey);
      } catch {
        throw new Error('wallet file is corrupted');
      }
      if (derivedPublicKey !== entry.publicKey) {
        throw new Error('wallet file is corrupted: key mismatch');
      }
      secrets.set(entry.address, privateKey);
    }

    this.masterKey = key;
    this.privateKeys = secrets;
  }

  /**
   * Re-encrypt every private key under a new passphrase with a fresh salt.
   * The wallet must already be unlocked, so the old passphrase is verified by
   * `unlock` before this runs. Nothing is written to disk until every new
   * ciphertext has been decrypted back and compared, and the file remains in
   * the encrypted version 2 format throughout.
   */
  changePassphrase(passphrase) {
    if (!this.isEncrypted) {
      throw new Error(
        'wallet is not encrypted; run "doubloom wallet lock" to set a passphrase',
      );
    }
    if (!this.isUnlocked) {
      throw new Error('wallet is locked; unlock it before changing the passphrase');
    }

    const { crypto, key } = createEncryption(passphrase);
    const rewrapped = [];

    for (const entry of this.data.keys) {
      const privateKey = this.privateKeys.get(entry.address);
      if (!privateKey) {
        throw new Error('wallet file is corrupted: a key could not be decrypted');
      }
      const payload = encryptPrivateKey(
        privateKey,
        key,
        this.additionalData(entry.address),
      );
      if (
        decryptPrivateKey(payload, key, this.additionalData(entry.address)) !==
        privateKey
      ) {
        throw new Error('passphrase change failed: re-encrypted key did not verify');
      }
      rewrapped.push({ entry, payload });
    }

    for (const { entry, payload } of rewrapped) {
      entry.encryptedPrivateKey = payload;
    }
    this.data.crypto = crypto;
    this.masterKey = key;
    this.save();
  }

  /**
   * Write an encrypted copy of the wallet and verify that the copy decrypts.
   * The source is re-read and unlocked with the passphrase, so the backup is
   * checked against the file on disk rather than any in-memory state. Plaintext
   * wallets are refused: an export must never contain readable private keys.
   *
   * The backup file format, which archives already on disk depend on:
   *
   *   bytes 0-1   `1f 8b` — gzip magic, the only thing that marks compression
   *   byte  2     `08` — deflate, as gzip requires
   *   byte  3     `00` — no optional header fields (no name, comment or CRC)
   *   bytes 4-7   export time, unix seconds, little endian, in gzip's MTIME
   *               field; zlib writes zero and it is patched here. Read as an
   *               ISO stamp by `backupArchiveTime`, and it is the only thing in
   *               the container that is not the wallet itself
   *   bytes 8-9   XFL and OS — written by zlib, never read back
   *   body        deflate of the wallet file, byte for byte: the same version 2
   *               JSON (encrypted keys, no plaintext) that the live wallet holds
   *   trailer     CRC-32 of the uncompressed wallet, then its length, both
   *               little endian — gzip's standard, which zlib checks on read
   *
   * A plain-JSON wallet file is also accepted on restore, for exports written
   * before compression. Nothing here is versioned separately from the wallet
   * JSON: the payload's `version` field is the wallet's own (2 today), and a
   * future container change must keep `backupArchiveTime` and `readWalletBytes`
   * able to read what this writes, or accept the old shape alongside a new one.
   */
  backup(destination, passphrase) {
    // Backups are gzip, like node archives, and named to say so. A destination
    // that already ends in .gz is used as given rather than doubled.
    const target = destination.endsWith('.gz') ? destination : `${destination}.gz`;
    const source = Wallet.load(this.file, this.params);
    if (!source) {
      throw new Error(`no wallet at ${this.file}`);
    }
    if (!source.isEncrypted) {
      throw new Error(
        'wallet is not encrypted; run "doubloom wallet lock" before backing it up',
      );
    }
    source.unlock(passphrase);

    const raw = fs.readFileSync(this.file);
    const bytes = zlib.gzipSync(raw);
    // zlib leaves gzip's MTIME field zero; record the export time in it so the
    // archive can say when it was made even after being copied elsewhere. The
    // checksum covers the uncompressed data, not the header, so this is safe.
    bytes.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`backup file already exists: ${target}`);
      }
      fs.rmSync(target, { force: true });
      throw error;
    }

    try {
      // Read the archive back through the same path `restore` uses, so the check
      // covers decompression as well as the passphrase.
      const copy = Wallet.load(target, this.params);
      if (!copy?.isEncrypted) {
        throw new Error('backup copy is not encrypted');
      }
      copy.unlock(passphrase);
      return {
        path: target,
        bytes: bytes.length,
        rawBytes: raw.length,
        keys: copy.listKeys().length,
        // The stamp stored in the archive, read back the way `restore` reads it
        // rather than echoed from the clock, so what is printed now is what will
        // be printed when this export is restored.
        at: backupArchiveTime(target),
      };
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw new Error(`backup verification failed: ${error.message}`);
    }
  }

  /**
   * Install an encrypted backup as a wallet file. The backup is decrypted and
   * checked first, then written to a temporary file, decrypted again, and only
   * then renamed into place. An existing wallet is never replaced unless
   * `force` is set.
   */
  static restore(source, destination, params, passphrase, { force = false } = {}) {
    const incoming = Wallet.load(source, params);
    if (!incoming) {
      throw new Error(`no backup at ${source}`);
    }
    if (!incoming.isEncrypted) {
      throw new Error(
        'backup is not encrypted; refusing to restore a plaintext wallet',
      );
    }
    incoming.unlock(passphrase);

    if (fs.existsSync(destination) && !force) {
      throw new Error(
        `a wallet already exists at ${destination}; move it aside or pass --force to overwrite it`,
      );
    }

    // A compressed backup is installed as a normal wallet file: decompress
    // before writing, so the wallet on disk is always the plain JSON format.
    const { bytes } = readWalletBytes(source);
    const temporary = `${destination}.restore.tmp`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      const check = Wallet.load(temporary, params);
      if (!check?.isEncrypted) {
        throw new Error('restored copy is not encrypted');
      }
      check.unlock(passphrase);
      fs.renameSync(temporary, destination);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`restore verification failed: ${error.message}`);
    }

    return Wallet.load(destination, params);
  }

  /**
   * Decrypt the wallet back to the plaintext version 1 format. This is the
   * explicit `wallet unlock` command: it enables signing without a prompt but
   * leaves private keys unencrypted on disk until `wallet lock` runs again.
   */
  decryptToPlaintext(passphrase) {
    if (!this.isEncrypted) {
      return false;
    }

    this.unlock(passphrase);

    for (const entry of this.data.keys) {
      const privateKey = this.privateKeys.get(entry.address);
      if (!privateKey) {
        throw new Error('wallet file is corrupted');
      }
      entry.privateKey = privateKey;
      delete entry.encryptedPrivateKey;
    }

    delete this.data.crypto;
    this.data.version = 1;
    this.masterKey = null;
    this.privateKeys = new Map();
    this.save();
    return true;
  }

  listKeys() {
    return this.data.keys;
  }

  defaultKey() {
    return this.data.keys[0] ?? null;
  }

  findKey(address) {
    return this.data.keys.find((key) => key.address === address) ?? null;
  }

  balance(chain, address) {
    return chain.balanceOf(address ?? this.defaultKey()?.address);
  }

  /**
   * Build and sign a payment. Selects UTXOs largest-first, pays the exact
   * size-based fee, and returns change to the sending address.
   */
  buildTransaction(chain, { from, to, amount, feeRate } = {}) {
    const params = chain.params;
    if (typeof to !== 'string') {
      throw new Error('a recipient address is required');
    }
    decodeAddress(to, params.addressVersion);

    const value = typeof amount === 'bigint' ? amount : parseAmount(amount);
    if (value <= 0n) {
      throw new Error('amount must be greater than zero');
    }

    const entry = from ? this.findKey(from) : this.defaultKey();
    if (!entry) {
      throw new Error(
        from ? `no key for ${from} in this wallet` : 'wallet has no keys',
      );
    }

    const key = {
      ...entry,
      privateKey: this.privateKeyFor(entry.address),
    };

    const rate = Number(feeRate ?? params.minFeeRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('fee rate must be a positive number of petals per byte');
    }

    const nextHeight = chain.height + 1;
    const candidates = chain
      .utxosFor(key.address)
      .filter(
        (utxo) =>
          !utxo.coinbase ||
          nextHeight - utxo.height >= params.coinbaseMaturity,
      );

    if (candidates.length === 0) {
      throw new Error(`no spendable outputs for ${key.address}`);
    }

    const selected = [];
    let total = 0n;

    for (const utxo of candidates) {
      selected.push(utxo);
      total += utxo.value;

      const transaction = {
        version: 1,
        inputs: selected.map((input) => ({
          prevTxid: input.txid,
          vout: input.vout,
          sequence: 0xffffffff,
          scriptSig: { signature: '', pubkey: '' },
        })),
        outputs: [{ value: String(value), address: to }],
        locktime: 0,
      };

      const sign = () => {
        selected.forEach((prevout, index) =>
          signInput(transaction, index, key, prevout),
        );
      };

      // ECDSA signatures are DER encoded, so their length varies by a couple
      // of bytes between signings. Keep a per-input margin above the relay
      // fee so the final signature can never fall below it.
      const margin = 4 + 3 * selected.length;
      const feeFor = () =>
        BigInt(Math.max(Math.ceil((txSize(transaction) + margin) * rate), 1));

      sign();
      let fee = feeFor();
      let change = total - value - fee;

      if (change < 0n) {
        continue;
      }

      if (change >= params.dust) {
        // Add a change output and let fee and change settle on the exact
        // signed size: changing the amount can change its serialized length.
        transaction.outputs.push({
          value: String(change),
          address: key.address,
        });
        for (let pass = 0; pass < 8; pass += 1) {
          sign();
          const required = feeFor();
          const next = total - value - required;
          if (next < params.dust || next === change) {
            change = next;
            fee = required;
            break;
          }
          change = next;
          fee = required;
          transaction.outputs[1].value = String(change);
        }
      }

      if (change < params.dust) {
        // Too small to be worth an output: leave it to the miner.
        if (transaction.outputs.length > 1) {
          transaction.outputs.pop();
          sign();
        }
        fee = total - value;
        change = 0n;
      } else {
        sign();
        fee = total - value - change;
      }

      return {
        transaction,
        txid: txid(transaction),
        fee,
        change,
        total,
        key,
      };
    }

    throw new Error(
      `insufficient funds: available ${formatAmount(total)} DBL`,
    );
  }
}
