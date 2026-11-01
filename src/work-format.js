/**
 * How cumulative chain work is printed for a human — used by `doubloom info`
 * and by the explorer's Chain work card, which must read the same.
 *
 * Work is a BigInt and can reach 78 digits on a long mainnet chain, so it is not
 * printed in full everywhere: up to `WORK_FULL_DIGITS` digits it is grouped for
 * the operator's locale, and past that it is shortened, with the exact figure
 * kept wherever the whole number is available (the JSON output, the API, the
 * card's tooltip). The shortened form is deliberately not localized: it is a
 * magnitude, read the same in a log on any machine.
 *
 * `explorer.html` carries an inline copy, because the page is served as one
 * self-contained file and cannot import this module. The two are kept identical
 * by the test that evaluates the browser copy against this one.
 */

/** Digits that stay readable in full; 15 grouped digits is 19 characters. */
export const WORK_FULL_DIGITS = 15;

/** Grouped work if it fits, an exponent form of the same digits if it does not. */
export function formatWork(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) {
    return '—';
  }
  if (text.length <= WORK_FULL_DIGITS) {
    return BigInt(text).toLocaleString();
  }
  // Truncated rather than rounded, so the shown magnitude is never overstated.
  return `${text[0]}.${text.slice(1, 4)}e+${text.length - 1}`;
}
