import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { hash160 } from './hash.js';
import { decodeCheck, encodeCheck } from './base58.js';

/**
 * Doubloom keys are secp256k1 ECDSA keys, just like Bitcoin's.
 * The private key is stored as PKCS#8 DER hex, the public key as the
 * 65-byte uncompressed SEC point (0x04 || x || y) hex.
 */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
    publicKey: publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-65)
      .toString('hex'),
  };
}

export function privateKeyFromHex(privateKeyHex) {
  return createPrivateKey({
    key: Buffer.from(privateKeyHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromHex(publicKeyHex) {
  const bytes = Buffer.from(publicKeyHex, 'hex');
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('public key must be an uncompressed 65-byte secp256k1 point');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      x: bytes.subarray(1, 33).toString('base64url'),
      y: bytes.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Sign a 32-byte digest. Node hashes the supplied message once more with
 * SHA-256, so verification uses the exact same call.
 */
export function signDigest(digest, privateKeyHex) {
  return sign('sha256', digest, {
    key: privateKeyFromHex(privateKeyHex),
    dsaEncoding: 'der',
  }).toString('hex');
}

export function verifyDigest(digest, signatureHex, publicKeyHex) {
  try {
    return verify(
      'sha256',
      digest,
      { key: publicKeyFromHex(publicKeyHex), dsaEncoding: 'der' },
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/** Encode a 20-byte public key hash as a base58check address. */
export function addressFromHash(hash, addressVersion) {
  const bytes = Buffer.from(hash);
  if (bytes.length !== 20) {
    throw new Error('public key hash must be 20 bytes');
  }
  return encodeCheck(
    Buffer.concat([Buffer.from([addressVersion & 0xff]), bytes]),
  );
}

export function publicKeyFromPrivateKey(privateKeyHex) {
  return createPublicKey(privateKeyFromHex(privateKeyHex))
    .export({ format: 'der', type: 'spki' })
    .subarray(-65)
    .toString('hex');
}

export function addressFromPublicKey(publicKeyHex, addressVersion) {
  return addressFromHash(
    hash160(Buffer.from(publicKeyHex, 'hex')),
    addressVersion,
  );
}

/** Decode and validate an address, optionally checking the network version. */
export function decodeAddress(address, addressVersion) {
  if (typeof address !== 'string') {
    throw new Error('address must be a string');
  }
  const payload = decodeCheck(address);
  if (payload.length !== 21) {
    throw new Error('invalid address length');
  }
  if (addressVersion !== undefined && payload[0] !== addressVersion) {
    throw new Error('address belongs to a different network');
  }
  return { version: payload[0], hash: payload.subarray(1) };
}
