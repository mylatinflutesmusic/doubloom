import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * Wallet key encryption.
 *
 * Private keys are encrypted individually with AES-256-GCM. The 32-byte
 * encryption key is derived from the passphrase with scrypt. Each ciphertext
 * is bound to the wallet network and address through the GCM additional
 * authenticated data, so moving a ciphertext to another entry fails
 * authentication rather than decrypting to the wrong key.
 */

export const MIN_PASSPHRASE_LENGTH = 8;

export const KDF = Object.freeze({
  kdf: 'scrypt',
  n: 32_768,
  r: 8,
  p: 1,
  keyLength: 32,
  cipher: 'aes-256-gcm',
});

export function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('passphrase must not be empty');
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
}

export function createEncryption(passphrase) {
  assertPassphrase(passphrase);
  const salt = randomBytes(16).toString('hex');
  const crypto = { ...KDF, salt };
  return { crypto, key: deriveKey(passphrase, crypto) };
}

export function deriveKey(passphrase, crypto) {
  if (
    !crypto ||
    crypto.kdf !== KDF.kdf ||
    crypto.cipher !== KDF.cipher ||
    crypto.n !== KDF.n ||
    crypto.r !== KDF.r ||
    crypto.p !== KDF.p ||
    crypto.keyLength !== KDF.keyLength
  ) {
    throw new Error('unsupported wallet encryption parameters');
  }

  const salt = Buffer.from(String(crypto.salt ?? ''), 'hex');
  if (salt.length !== 16) {
    throw new Error('wallet encryption salt is corrupted');
  }

  return scryptSync(
    Buffer.from(passphrase.normalize('NFC'), 'utf8'),
    salt,
    KDF.keyLength,
    {
      N: KDF.n,
      r: KDF.r,
      p: KDF.p,
      maxmem: 128 * 1024 * 1024,
    },
  );
}

export function encryptPrivateKey(privateKey, key, additionalData) {
  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    throw new Error('private key must be a non-empty hex string');
  }
  if (!Buffer.isBuffer(key) || key.length !== KDF.keyLength) {
    throw new Error('wallet encryption key is invalid');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(KDF.cipher, key, iv);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

export function decryptPrivateKey(payload, key, additionalData) {
  const iv = Buffer.from(String(payload?.iv ?? ''), 'hex');
  const tag = Buffer.from(String(payload?.tag ?? ''), 'hex');
  const ciphertext = Buffer.from(String(payload?.ciphertext ?? ''), 'hex');

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('wallet encrypted key is corrupted');
  }

  try {
    const decipher = createDecipheriv(KDF.cipher, key, iv);
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase or corrupted wallet file');
  }
}
