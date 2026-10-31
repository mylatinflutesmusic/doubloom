# Mining on hardware you own

Doubloom exists to show how Bitcoin-style mining works, so it is the honest place
to measure what a general-purpose computer is worth as a miner. This page records
the measurement and the recipe for running a miner across more than one machine.

**Only machines you own or have written permission to use.** Running a miner on
someone else's computer is unauthorized access in most jurisdictions and is the
first thing endpoint protection looks for; on a work or school network it is a
policy violation even when the hardware is idle. Cloud free tiers are not
loopholes either — billing and abuse teams suspend accounts for it.

## What one machine is worth

`bench/hashrate.js` measures this machine's SHA-256d rate two ways: exactly as
the node's miner hashes, and tuned (header buffer reused, digest compared
byte-wise instead of through a hex string and a BigInt). It then converts the
faster of the two into what that rate would earn on Bitcoin's network.

```
$ node bench/hashrate.js --seconds 2

Doubloom hashrate benchmark · SHA-256d over an 80-byte header

  machine        4 × Intel(R) Core(TM) i5-2450M CPU @ 2.50GHz
  measured for   2s per loop

  node's miner   49.3 kH/s   (120,000 hashes in 2.44s)
  tuned loop     77.6 kH/s   (160,000 hashes in 2.06s)
  tuned vs node  1.6×   the miner spends its time rebuilding the header and parsing hex

What that rate is worth against Bitcoin

  network        800 EH/s assumed, so one block every 10 minutes network-wide
  your share     9.70e-17 of the network's hashing power
  one ASIC is    2,576,742,250× this machine, so 4,000,000 ASICs equal the network
  solo block     196 billion years on average — you will not mine one
  in a pool      4.37e-14 BTC per day at 95 W and $0.15/kWh
  power costs    $0.34 per day (2.3 kWh)
  verdict        BTC would have to trade at $7,833,296,440,000 for this machine to cover its electricity; below that, mining is a loss
```

The rates are measured; the network hashrate, the power draw and the electricity
price are inputs (`--network-hashrate`, `--watts`, `--kwh`). On this laptop one
ASIC is worth about two and a half billion of it, so a pool pays a rounding
error and the wall socket takes $0.34 a day. Adding machines multiplies the hash
rate and the power bill by the same factor, which is why a fleet of desktop PCs
does not turn into a profit: the ratio between them and the network's ASICs does
not change.

What a fleet *does* buy is an honest local network, which is what the rest of
this page is for.

## Two machines, one chain

Each node needs its own data directory, because the wallet and chain live there.
`init` creates both:

```bash
node src/cli.js --datadir ~/dbl-a --network devnet init
node src/cli.js --datadir ~/dbl-b --network devnet init
```

On the machine that will mine, bind beyond loopback so the other can reach it.
`--announce` tells peers which address actually works from outside:

```bash
# miner, 192.168.1.20
node src/cli.js --datadir ~/dbl-a --network devnet node \
  --host 0.0.0.0 --port 18338 --announce 192.168.1.20:18338 --mine
```

On the second machine, point at the first:

```bash
# follower, then mine it too
node src/cli.js --datadir ~/dbl-b --network devnet node \
  --port 18339 --peers http://192.168.1.20:18338
```

The follower syncs the whole chain on start and then follows it:

```
synced 175 block(s), 174.7 KiB from http://192.168.1.20:18338
startup sync: 175 block(s), 174.7 KiB from 1 peer · height 175
received block 176 0000c0c7819… from 192.168.1.20 (1 tx)
relayed block 176 to 1 peer
```

Either node's miner can be started or stopped without a restart, from the other
machine or from a script:

```bash
curl -s -X POST http://192.168.1.20:18338/api/mining \
  -H 'content-type: application/json' -d '{"enabled": false}'
```

Blocks mined on one node relay to the other, which accepts and re-relays them:

```
mining resumed via API to mnBk2xVYbMRxJYZ2CAETtqbAx5pDBi6Ap1
mined block 183 00004cb8c8ef… (1 tx, reward 50 DBL)
relayed block 183 to 1 peer
```

Both wallets collect the subsidy for their own blocks, so the reward follows the
hardware rather than the address. Coinbase outputs mature after 100 blocks,
which is why a fresh miner shows coins under `immature` for a while:

```
  confirmed       550 DBL
  spendable       0 DBL
  immature        550 DBL (coinbase maturity)
```

Two nodes mining the same chain also demonstrate the part of Bitcoin that is
easiest to get wrong: when both find a block at the same height, they briefly
disagree, and the node that sees a heavier branch later replaces its own. Watch
`chain work` in `/api/info` (or the explorer's Chain work card) rather than the
height, since height alone does not say which branch wins.

### Reaching the node over the LAN

The node API has no authentication. Anyone who can reach `POST /api/mining` can
stop that node's miner, and the same port exposes transaction submission, peer
registration and backup download. Keep it on a private network or behind a proxy
that adds auth, and do not port-forward it to the internet. `--announce` exists
for the cases the machine cannot work out itself — a port forward, or a public
name — not as an invitation to expose the API.

## If you want real Bitcoin

Doubloom is a re-implementation, so the loop it runs is the real one minus the
network. To watch actual `bitcoind` do the same thing without spending anything,
run it in regtest, where blocks are trivial to find and coins are worthless by
construction:

```bash
bitcoind -regtest -daemon
bitcoin-cli -regtest createwallet test
ADDR=$(bitcoin-cli -regtest getnewaddress)
bitcoin-cli -regtest generatetoaddress 101 "$ADDR"   # 101 so the first reward matures
bitcoin-cli -regtest getbalance                      # 50.00000000
```

`generatetoaddress` mines; each block pays 50 regtest BTC and the first 100 are
immature. That is the whole pipeline — header, nonce, target, coinbase, maturity
— on your own machine, with no pool, no electricity cost worth measuring and no
one else's computer involved. For testnet instead of regtest, add `-testnet` and
expect real proof-of-work, at real difficulty, for worthless coins.
