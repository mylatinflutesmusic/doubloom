import { COIN } from './params.js';

/** Format a petal amount as a DBL decimal string, e.g. 123456789n -> "1.23456789". */
export function formatAmount(petals, { trim = true } = {}) {
  const value = BigInt(petals);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / COIN;
  const fraction = (absolute % COIN).toString().padStart(8, '0');
  let text = trim ? `${whole}.${fraction}`.replace(/\.?0+$/, '') : `${whole}.${fraction}`;
  if (text === '') text = '0';
  return negative ? `-${text}` : text;
}

/** Parse a human DBL amount ("1.5") into petals. */
export function parseAmount(text) {
  const input = String(text).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(input)) {
    throw new Error(`invalid amount "${text}" (use up to 8 decimal places)`);
  }
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * COIN + BigInt(fraction.padEnd(8, '0'));
}

export function formatWithTicker(petals) {
  return `${formatAmount(petals)} DBL`;
}
