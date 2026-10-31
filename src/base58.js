import { sha256d } from './hash.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map(
  [...ALPHABET].map((character, index) => [character, BigInt(index)]),
);

/** Classic Bitcoin base58 encoding (leading zero bytes become "1"s). */
export function encode(buffer) {
  const bytes = Buffer.from(buffer);
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = '';
  while (value > 0n) {
    encoded = ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded || '1';
}

export function decode(string) {
  if (typeof string !== 'string' || string.length === 0) {
    throw new Error('invalid base58 string');
  }

  let value = 0n;
  for (const character of string) {
    const digit = ALPHABET_MAP.get(character);
    if (digit === undefined) {
      throw new Error(`invalid base58 character "${character}"`);
    }
    value = value * 58n + digit;
  }

  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }

  for (const character of string) {
    if (character !== '1') break;
    bytes.unshift(0);
  }

  return Buffer.from(bytes);
}

/** base58check: payload followed by the first 4 bytes of sha256d(payload). */
export function encodeCheck(payload) {
  const body = Buffer.from(payload);
  const checksum = sha256d(body).subarray(0, 4);
  return encode(Buffer.concat([body, checksum]));
}

export function decodeCheck(string) {
  const raw = decode(string);
  if (raw.length < 5) {
    throw new Error('invalid base58check string');
  }
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  if (!sha256d(payload).subarray(0, 4).equals(checksum)) {
    throw new Error('invalid address checksum');
  }
  return payload;
}
