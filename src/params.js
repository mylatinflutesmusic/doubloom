/**
 * Doubloom consensus parameters.
 *
 * The numbers deliberately mirror Bitcoin:
 *   - SHA-256 double hashing for proof-of-work and transaction ids
 *   - one block every 10 minutes, difficulty retargeted every 2016 blocks
 *   - 50 DBL subsidy, halved every 210,000 blocks
 *   - hard cap of 21,000,000 DBL
 *   - UTXO ledger, secp256k1 ECDSA signatures, base58check addresses
 */

/** The smallest unit of Doubloom. 1 DBL = 100,000,000 petals. */
export const PETAL = 1n;
export const COIN = 100_000_000n; // petals per DBL
export const MAX_MONEY = 21_000_000n * COIN; // 2,100,000,000,000,000 petals

/** Compact "bits" encoding of the easiest allowed target for mainnet. */
const MAINNET_POW_LIMIT = 0x1f00ffff;

const COMMON = {
  symbol: 'Đ',
  ticker: 'DBL',
  unit: 'petal',
  petalsPerCoin: COIN,
  maxMoney: MAX_MONEY,
  targetBlockTime: 600, // seconds
  retargetInterval: 2016, // blocks
  halvingInterval: 210_000, // blocks
  initialSubsidy: 50n * COIN,
  coinbaseMaturity: 100, // blocks before a coinbase output can be spent
  maxBlockBytes: 1_000_000,
  maxTxBytes: 100_000,
  minFeeRate: 1, // petals per byte (Bitcoin's 1 sat/vB relay fee)
  dust: 546n, // petals
  genesisTime: 1_735_689_600, // 2025-01-01T00:00:00Z
  genesisMessage:
    'The Times 29/Oct/2026 — Doubloom blooms on the shoulders of Bitcoin',
};

export const NETWORKS = {
  mainnet: Object.freeze({
    ...COMMON,
    name: 'mainnet',
    addressVersion: 0x1e, // base58check addresses start with "D"
    powLimitBits: MAINNET_POW_LIMIT,
    // Early Doubloom blocks are mined by a small network, so the genesis
    // difficulty is low (~2^16 hashes). The retarget rules raise it from there.
    genesisBits: MAINNET_POW_LIMIT,
    defaultPort: 8338,
    // Seed hostnames resolved at startup to find peers automatically. There is
    // no published Doubloom seed infrastructure yet, so this is empty and a
    // node starts with no peers unless --seed or --peers is given. Add the
    // network's seed host(s) here once they exist.
    dnsSeeds: [],
  }),
  devnet: Object.freeze({
    ...COMMON,
    name: 'devnet',
    addressVersion: 0x6f, // testnet-style addresses, start with "m" or "n"
    powLimitBits: 0x207fffff,
    genesisBits: 0x207fffff,
    retargetInterval: 20,
    targetBlockTime: 60,
    defaultPort: 18338,
    dnsSeeds: [],
  }),
};

export function networkParams(name = 'mainnet') {
  const params = NETWORKS[name];
  if (!params) {
    throw new Error(
      `unknown network "${name}" (expected ${Object.keys(NETWORKS).join(' or ')})`,
    );
  }
  return params;
}
