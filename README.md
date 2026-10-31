# Doubloom · Đ · DBL

![Doubloom coin](assets/doubloom.png)

Doubloom is a Bitcoin-style cryptocurrency built from scratch in Node.js: SHA-256
proof-of-work, a UTXO ledger with secp256k1 signatures, base58 addresses, a fixed
21,000,000 DBL cap, ten-minute blocks and a halving every 210,000 blocks. It runs
as a command-line wallet/miner, a peer-to-peer node, and a block explorer.

The coin's mark is a gold coin with a double-barred **Đ**, drawn in the spirit of
the original Bitcoin coin. The source artwork is [assets/doubloom.svg](assets/doubloom.svg)
(render: [assets/doubloom.png](assets/doubloom.png)).

The design is described, with diagrams, in the [Doubloom whitepaper](whitepaper/doubloom-whitepaper.pdf)
([HTML source](whitepaper/doubloom-whitepaper.html)).

> **Experimental software. Not audited. Not money.** Doubloom is a working
> demonstration of Bitcoin's design, not a production payment network. Do not
> mine it, trade it, or store value in it.

## Coin specification

| Property | Doubloom |
| --- | --- |
| Ticker / symbol | DBL / Đ |
| Hashing | SHA-256d (double SHA-256) for proof-of-work, txids and checksums |
| Proof of work | Hashcash-style, 80-byte header, compact `bits` target |
| Block interval | 600 seconds (10 minutes) |
| Difficulty retarget | Every 2,016 blocks, clamped to 4× per retarget |
| Block subsidy | 50 DBL, halved every 210,000 blocks |
| Hard cap | 21,000,000 DBL (nominal) |
| Smallest unit | 1 petal = 0.00000001 DBL (all amounts are integers) |
| Ledger | UTXO, pay-to-public-key-hash |
| Signatures | ECDSA secp256k1, DER encoded |
| Addresses | base58check, version byte `0x1e`, mainnet addresses start with `D` |
| Coinbase maturity | 100 blocks |
| Block size limit | 1,000,000 bytes |
| Minimum relay fee | 1 petal per byte |
| Consensus | Longest chain by cumulative proof-of-work, with reorgs |

Because subsidies are halved with integer division, the last few halvings round
down and the total that can ever be minted is 20,999,999.9769 DBL — the same
quirk Bitcoin has. The genesis subsidy is sent to a burn address (20 zero bytes)
and is permanently unspendable, so Doubloom started with **no pre-mine**.

## Requirements

Node.js 18 or newer. There are no dependencies to install.

## Quick start

```bash
node src/cli.js init                  # create the mainnet genesis chain + wallet
node src/cli.js mine --blocks 101     # mine coins (coinbase matures after 100 blocks)
node src/cli.js info                  # height, difficulty, supply, balance
node src/cli.js address               # receive address
```

Send a payment and confirm it:

```bash
node src/cli.js send DYourRecipientAddress 2.5
node src/cli.js mempool
node src/cli.js mine --blocks 1
```

Run a node with the block explorer and keep mining:

```bash
node src/cli.js node --mine
# explorer: http://127.0.0.1:8338
```

`node src/cli.js` can be replaced with `doubloom` after `npm link` (or
`npm install -g .`). To use the fast test network instead of mainnet, add
`--network devnet` to every command (devnet uses testnet-style addresses and
mines quickly).

### Two nodes on one machine

```bash
# node 1
node src/cli.js node --port 8338 --mine

# node 2 (separate data directory)
node src/cli.js --datadir node2 init
node src/cli.js --datadir node2 node --port 8339 --peers http://127.0.0.1:8338
```

Nodes sync the full chain on start and every 20 seconds, relay new blocks and
transactions to their peers, and switch to a competing chain when it has more
cumulative proof-of-work.

Syncing is incremental. Each node sends a locator — its ten newest block hashes followed by
progressively older ones back to genesis — and the peer replies with only the
blocks above the highest hash it shares (plus `from`, the height it split at).
A node at the tip transfers nothing; a node resuming ten blocks behind transfers
ten blocks instead of the whole chain. The reply still carries the full chain
when the locator shares nothing, so a peer with unrelated history falls back to
the old behaviour, and a peer that does not understand `locator` answers with
its full chain, which the caller also handles.

Accepting those blocks is incremental too. When the peer's blocks are a straight
extension of this node's tip, only the new blocks are validated and applied,
updating the UTXO set in place; the chain is not replayed from genesis. The
known-block set gains just the new hashes instead of being rebuilt. On a
150-block devnet chain, adopting a three-block extension costs under a
millisecond, against roughly 34 ms for a full replay, and the full-replay cost
grows with the chain while the extension cost grows with the number of new
blocks. A genuine fork still replays everything above the fork point, because
every one of those blocks replaces a block of ours, and the UTXO set is rebuilt
rather than patched. A block that fails validation part-way through an extension
rolls the chain back to its previous tip, so a bad batch leaves nothing half
applied.

Sync hands its suffix to `adopt()` together with the height it split at, rather
than concatenating it to our own chain first. `adopt()` then checks a single
parent hash to confirm the link (refusing a suffix that does not descend from
that block), measures the peer's work by summing only the suffix and the branch
it replaces, and replays the fork as two ranges — our prefix, then the peer's
suffix — instead of building the joined chain. Nothing hashes or walks our own
chain: on a 50,000-block chain the old fork path spent about 0.96 s hashing
every header into a lookup map and another 0.11 s summing the merged work, both
per sync pass. A suffix that adds no work is rejected exactly like a lighter
whole chain.

The two-range replay is what keeps a reorg from needing a second copy of the
chain. The prefix is read where it already sits, the suffix is walked as the
peer sent it, and only after validation succeeds is our own list changed —
truncated at the fork point and appended to in place. The array is never
replaced, so nothing holds two copies of every block: at 19,601 blocks the
joined array the old path allocated was 452 KiB, and that allocation is now
gone. The walk costs the same: replaying the two ranges took 4.22 s on a
20,000-block chain where replaying a joined array took 4.18 s.

The node's known-block set — the hashes it uses to tell a duplicate push from a
block on a branch it has never seen — is updated just as incrementally. An
adoption returns the hashes of the blocks that lost, so the node deletes exactly
those and adds the blocks above the fork instead of rehashing the chain it kept.
On a 20,000-block chain with a 1,000-block fork that is 1,000 hashes for the
dropped branch and 1,200 for the adopted suffix — 4.2 ms, against 454 ms to
rehash all 20,001 headers. (The 4.2 ms includes copying the whole set before
editing it; the node mutates its own set directly, so the real cost is lower
still.) The saving is proportional to chain length rather than fork depth, so a
shallow reorg on a long chain is where it shows; a reorg deeper than most of the
chain still hashes most of it, which is inherent in replacing it.

A pushed block that does not extend the tip is not simply rejected: if the
block is one the node has never seen, the sender is evidently on a branch the
node does not know, so it fetches its peers' chains at once (about 250 ms)
instead of leaving the fork standing until the next 20-second pass. Repeats are
spaced at least five seconds apart, because two nodes that mine at the same
time reject each other's blocks continuously and each fetch downloads a whole
chain. Blocks the node already has — including a peer echoing back a block it
was just sent — never trigger a fetch, so ordinary relaying causes no extra
work. The periodic sync remains the backstop for peers that go quiet.

A node logs what it accepts and passes on, so a peer's adoption is visible in
its own log rather than only in the miner's:

```
mined block 147 00001c2afed1fca42c5d2008af0ad61a373a042401130c4ee5054f4ee17d04e6 (1 tx, reward 50 DBL)
relayed block 147 to 1 peer
received block 147 00001c2afed1fca42c5d2008af0ad61a373a042401130c4ee5054f4ee17d04e6 from 127.0.0.1 (1 tx)
received tx 9b7f0c2e5a1d4f3b8e6c0a2d4f6b8e0c2a4d6f8b0e2c4a6d8f0b2e4c6a8d0f2b from 127.0.0.1 (1 in, 1 out, 0.0001 DBL fee)
relayed tx 9b7f0c2e5a1d4f3b8e6c0a2d4f6b8e0c2a4d6f8b0e2c4a6d8f0b2e4c6a8d0f2b to 1 peer
synced 70 block(s), 148.6 KiB from http://127.0.0.1:18430
```

A sync line reports the bytes that peer's response cost as well as the blocks
adopted, so bandwidth is visible without a packet capture. The two are separate
facts: an up-to-date peer answering a locator transfers a hundred bytes or so
and logs nothing, a peer ten blocks ahead transfers a few kilobytes, and a peer
too old to understand `locator` transfers its whole chain — the same `synced 3
block(s)` can read `4.1 KiB` or `180.0 KiB` depending on which peer answered.

The first pass after start-up, the one that decides what the node is missing,
also ends with a single summary line totalling every peer, so the result does
not have to be pieced together from per-peer lines:

```
startup sync: 12 block(s), 12.0 KiB from 1 peer · height 12
startup sync: up to date at height 12 (71 B from 1 peer)
```

It is logged once, on the first pass that actually reaches a peer, and never
again — later syncs stay silent unless they adopt blocks. A node with no peers
at all prints nothing extra, since there was no pass to summarise.

Those transfers also accumulate per peer. Every request the node makes of a
peer — the sync, block and transaction pushes, the start-up announcement and
the reachability probes — is counted by request-body bytes out and
response-body bytes in, and `/api/info` reports the running totals since the
node started:

```json
"peerTraffic": {
  "sent": 65,
  "received": 4299,
  "peers": [
    {
      "peer": "http://127.0.0.1:18821",
      "connected": true,
      "sent": 65,
      "received": 4299,
      "total": 4364,
      "requests": 3,
      "lastAt": "2026-10-31T04:44:30.940Z"
    }
  ]
}
```

The explorer's **Peers** panel renders the same figures with a `4.2 KiB in ·
65 B out` headline and one row per peer, keeping a peer that has left the set so
its cost stays visible. Totals are body bytes only: request headers and the
status line are not counted, and neither is traffic another node pushes at this
one, since an inbound POST carries no peer identity beyond a source IP. A GET
sync therefore shows `sent` staying at whatever the announcements cost while
`received` grows with the chain.

`received` is logged only for blocks that actually connect to the tip; a
block that is invalid or already known is rejected with HTTP 400 and not
logged, because peers re-broadcast blocks they receive and those duplicates
would otherwise flood the log. `relayed` reports how many peers accepted the
POST, and is omitted when there are none. Transactions follow the same
accepted-only rule: a node logs `received tx` with the sender's address, the
input and output counts and the fee once the transaction is in its mempool, and
`relayed tx` only for the peers that actually took it. A duplicate (already in
the mempool), a conflicting spend or an invalid signature is rejected with HTTP
400 and logged nowhere, so the relay echo between two nodes that both hold a
transaction does not double the log. The txid is printed in full, so the two
lines and the peer's own `received tx` line can be matched by eye. A rejected
block that is new to the node gets its own line before the fetch it triggers:

```
block 0000bae11191fd5de2a3cd2c5cad2a8e4e320b2c0d03d7d4eaa23fb11ea82569 from 127.0.0.1 does not extend our tip; requesting the peer chain
```

### Announcing a reachable address

Binding to `0.0.0.0` listens on every interface, but it does not say which of
those addresses another machine can reach. A node announces itself to peers
through `POST /api/peers`, and announcing a loopback URL leaves every peer with
an address that only works on this host.

- Default bind `127.0.0.1` announces the loopback address, which is correct
  because the node is not reachable from elsewhere anyway.
- With `--host 0.0.0.0`, the first non-loopback IPv4 address on this machine is
  announced automatically.
- `--announce` names the address explicitly for anything the machine cannot work
  out for itself — a public hostname, or a forwarded port that differs from the
  one the node bound.
- `--announce-interface` picks the interface the address is taken from, by name,
  instead of taking the first routable one.

```bash
# bind everywhere, tell peers the public name
doubloom node --host 0.0.0.0 --announce node.example.org:8338

# behind port forwarding: listen on 8338, be reached on 443
node src/cli.js --datadir node node --host 0.0.0.0 --port 8338 --announce 203.0.113.7:443

# a machine with several interfaces: announce the wired one
node src/cli.js --datadir node node --host 0.0.0.0 --announce-interface eth0
```

A bare host uses the port the node actually bound, so `--announce node.example.org`
is enough when the port is not translated. `http://host:port/` is accepted and
normalised. An address that cannot be parsed stops the node at startup rather
than being announced to peers.

When the announced address differs from the local one, the startup log says so:

```
Doubloom mainnet node listening on http://127.0.0.1:8338
Block explorer: http://127.0.0.1:8338
Announcing http://192.168.1.20:8338 to peers
```

If the machine has no routable interface address and `--announce` is not given,
the node announces loopback and says that it did, so the problem is visible in
the log instead of showing up later as peers that never connect. `/api/info`
reports the announced URL as `announce`; `explorer` stays the local URL, because
that is where the operator opens it.

A machine with several interfaces — ethernet, wifi, a VPN, a Docker bridge — has
several answers to "which address is reachable", and picking the first one is a
guess that is often wrong. `--announce-interface` makes it a decision: name an
interface (`eth0`, `en0`, `Wi-Fi 4`), and the announced address is that
interface's IPv4 address. Names with spaces work as long as they are quoted.

```
$ doubloom node --host 0.0.0.0 --announce-interface "Wi-Fi 4"
Doubloom devnet node listening on http://127.0.0.1:18338
Announcing http://192.168.12.82:18338 to peers (interface Wi-Fi 4)
```

A name this machine does not have stops the node at startup rather than quietly
falling back to a different interface:

```
$ doubloom node --host 0.0.0.0 --announce-interface eth9
error: unknown network interface "eth9" (this machine has Wi-Fi 4, Loopback Pseudo-Interface 1)
```

An interface that exists but has no IPv4 address right now is treated as
temporary, not as a mistake: the node starts on loopback and says why, then
adopts the interface's address as soon as it has one. If a chosen interface
loses its address while the node runs, the last address that worked keeps being
announced and the warning is logged once per outage — the node does not demote
itself to loopback, and never borrows another interface's address.

`--announce-interface` and `--announce` cannot be combined: one states the
address outright, the other derives it, so the node refuses to guess which was
meant. Only the derived forms are watched; an explicit address is never
overridden.

A wildcard-bound node keeps watching its interfaces, every 30 seconds. When the
address changes — a laptop moving between networks, a new DHCP lease, an
interface going down — the announcement follows it without a restart: the node
logs both addresses, re-announces to every known peer immediately, rewrites
`node.json`, and re-probes the new address within about half a second instead of
waiting for the ten-minute reachability cycle.

```
announced address changed from http://192.168.1.20:8338 to http://10.0.0.5:8338 (network interface changed); re-announcing to peers
re-announced http://10.0.0.5:8338 to 2 peers
announced address http://10.0.0.5:8338 is reachable from http://10.0.0.9:8338
warning: no routable address found; announcing http://127.0.0.1:8338 until an interface returns (set --announce to pin one)
```

The re-announcement is a `POST /api/peers` to every known peer as soon as the
change is seen, not on the next sync pass: a peer still holding the old address
would keep handing it out in the meantime, and the log reports how many peers
accepted the new one. The reachability check is pulled forward the same way —
peers are told first, then a peer is asked to dial the new address, so a change
that broke port forwarding shows up as a warning seconds after it happened. Both
steps coalesce, so an interface that flaps several times still costs one probe
per settled address. Measured on a loopback peer: 27 ms from the interface
change to the peer receiving the new address, and 534 ms to the probe request.

An explicit `--announce` is never overridden: it describes port forwarding or a
public name the machine cannot discover, so the watch is skipped entirely. A
node bound to a specific host also has nothing to watch, since its address is
the one it bound. With `--announce-interface`, the watch follows that interface
only — a DHCP lease routed to a different address on it is picked up, while
another interface coming up is ignored.

The same address is visible without reading the log or the API. A running node
writes `<datadir>/<network>/node.json` when it binds, and both surfaces read it:

```
$ doubloom info
  announced       http://203.0.113.7:8338 pid 7936
  miner           mining
```

The `miner` row sits directly under it, because who and what the node is are the
same question when two nodes share a machine: `doubloom info` asks the recorded
port on loopback for `/api/mining` and prints `mining`, `paused`, `node not
running` once that process has exited, or `unknown (the node did not answer)`
when the port refuses — which is what a node bound only to a LAN address does,
since it cannot be reached over loopback. Unknown is deliberately distinct from
paused: silence is not evidence that the miner is off. The same value is in
`info --json` as `node.mining` (`true`, `false`, or `null`), so a script can read
it without a second command, and the query has a 1.5-second timeout so `info`
stays quick when nothing is listening.

### Checking that the announced address works

Announcing an address is a promise, and a node cannot test it from the inside:
its own request may take a local shortcut, and NAT hairpinning often fails. So it
asks a peer to dial it. Five seconds after binding, and then every ten minutes,
the node sends `POST /api/reachability` with its announced URL to up to three
peers. It also runs half a second after a new peer is learned — from DNS seed
discovery or from a peer registering itself through `POST /api/peers` — because
a new peer is a new chance to be tested, and an operator who just added one
should not have to wait out the ten-minute tick for the answer. A seed pass that
resolves several peers produces one check, not one per peer, and a peer that
arrives while a check is already running gets the check after it. The peer fetches `<url>/api/info` with a four-second timeout and answers
`{ reachable, network, height }`, or `{ reachable: false, error }`; anything that
is not a Doubloom node counts as unreachable.

Success is reported once, and again only if the address recovers:

```
announced address http://192.168.1.20:8338 is reachable from http://203.0.113.9:8338
```

A failure is warned about on every check, because it stays broken until someone
acts on it:

```
warning: peer http://203.0.113.9:8338 could not reach the announced address http://203.0.113.7:8338 (HTTP 404); check --announce, port forwarding and firewalls
```

The last result is kept in memory and reported by `/api/info` as
`reachability` — `{ peer, url, reachable, error, at }`, or `null` before the
first check and again after the announced address changes, since the old verdict
describes an address the node no longer uses. `at` is when the check ran, so a
stale answer is distinguishable from a fresh one.

That warning is the useful case: a node that announces a LAN address on a host
whose peers are remote, a port forward that points at the wrong port, or a
firewall that drops the request all look like this instead of looking like a
silent lack of peers. Peers that predate the route answer 404 and are skipped,
so a node whose peers cannot answer the check stays quiet rather than warning
about every address. `POST /api/reachability` makes a node fetch a URL, so keep
the API bound to peers you trust.

The explorer shows it in the header next to the mining/paused pill, labelled
`announced`, with the full URL in the tooltip — which is how you tell a node
bound to `0.0.0.0` that peers see `http://192.168.1.20:8338` from one that is
advertising a public name. A small badge follows the URL: `reachable` in green
or `unreachable` in red, with the checking peer's URL, the time and the error in
its tooltip (`a peer could not reach this node from http://127.0.0.1:18882 at
2026-10-31 05:17:03 UTC (22s ago): ECONNREFUSED`). It stays hidden until a check
has run, so an unchecked node does not look like a failed one, and the badge is
re-read with the rest of the page every five seconds, which is how a recovery
shows up without a reload. The row is omitted when the node has never run in
that data directory, and a node that is no longer alive is marked `last run`
rather than showing a live pid. On a narrow screen the announcement is hidden
to leave room for the mining control; `/api/info` and `doubloom info` still
report it.

### Finding peers through DNS seeds

Instead of naming a peer's URL, a node can resolve DNS seed hostnames and treat
every address they return as a peer:

```bash
# node 2 discovers node 1, and announces itself back
node src/cli.js --datadir node2 node --port 8339 --seed localhost:8338
```

A seed may be `host`, `host:port`, or a full `http://host:port/` URL; a bare
host uses the node's own port. Seeds are resolved at startup and re-resolved
every five minutes, so addresses that appear later are picked up and dead ones
stop being used. Each resolved address becomes a peer, up to eight peers total;
new peers are announced to and synced from immediately, and the node reuses the
existing sync/relay path. A seed that does not resolve is reported once and
does not stop the node or the other seeds.

`--seed` replaces the configured seeds for that run, `--seed none` or
`--no-seed` disables discovery entirely, and `--peers` still adds peers by URL.
There is no published Doubloom seed infrastructure yet, so `dnsSeeds` in
`params.js` is empty and nodes start with no peers unless a seed or peer is
given; add the network's permanent seed hostnames there to make discovery work
with no flags.

`/api/info` reports `seeds` (how many are configured) and `discovery` (last
resolution time, resolved hosts, addresses found and added, and any errors).

### Pausing and resuming mining

A node started with `--mine` mines continuously. `POST /api/mining` starts or
stops the miner on the running node, so an operator does not have to restart it:

```bash
# current state: mining, payout address, height, difficulty
curl -s http://127.0.0.1:8338/api/mining

# pause
curl -s -X POST http://127.0.0.1:8338/api/mining \
  -H 'content-type: application/json' -d '{"enabled": false}'

# resume
curl -s -X POST http://127.0.0.1:8338/api/mining \
  -H 'content-type: application/json' -d '{"enabled": true}'
```

The POST answers with `ok`, `changed` (false when the node was already in that
state, so repeating a request is harmless), `mining`, `address` and `height`, and
logs `mining paused via API at height N` or `mining resumed via API to
<address>` so the change appears in the same log as mined and synced blocks. A
body without a boolean `enabled` is rejected with 400, and a node with no payout
address refuses to start mining with 409 instead of accepting a request it
cannot honour.

Pausing stops only this node's miner: peers, transaction and block relay, sync
and backups keep running, and nothing about the chain changes. The state is held
in memory, so a restart returns to whatever `--mine` says on the command line.

The header pill reports the miner rather than the node: `mining` while it runs,
`paused` once it stops — whether it was stopped through the API or the node
simply started without `--mine` — and `offline` only when the API stops
answering, with a tooltip saying which. Peers, sync and backups carry on in the
paused state, so the pill is the quickest way to tell a node that is up and
idle from one that is no longer there.

The block explorer has the same control next to that pill: it reads
`Pause mining` while the miner runs and `Resume mining` while it does not, calls
`POST /api/mining`, and shows the height it acted on — or the node's refusal,
such as `no mining address; start the node with --address` — beside the button
for a few seconds. The button is disabled while a request is in flight and when
the node stops answering, and it re-reads `/api/info` every five seconds so a
change made from `curl` or another browser tab shows up here too. Each click is
an ordinary API call, so both routes are interchangeable and the action appears
in the node log (`mining paused via API at height N`).

The CLI does the same thing through that API, for scripted or headless use:

```bash
doubloom mining status      # state, payout address, height, difficulty
doubloom mining pause
doubloom mining resume
doubloom mining resume --port 18338
doubloom mining pause --url http://10.0.0.5:18338
```

It prints the resulting state and exits non-zero when no node answers, when the
node refuses (for example no payout address), or when the subcommand is unknown.

`--url` targets a node this machine did not start, instead of `--port`'s
`http://127.0.0.1:<port>`. It takes a bare http(s) origin — a scheme and host, an
optional port, and nothing else — and the command reports and prints that origin
rather than a loopback address that would be a lie for a remote node:

```
$ doubloom mining status --url http://10.0.0.5:18338 --json
{
  "node": "http://10.0.0.5:18338",
  "mining": false,
  "address": "mpdudQRBZ169LShXTPmZK39QFZRJL9tVKR",
  "height": 0,
  "difficulty": 1
}
```

Two things have to be true for that to answer. First, the remote node must be
listening beyond loopback: `--host 0.0.0.0` (or an `--announce`d interface, plus
whatever port forwarding or firewall rules are needed in front of it). Second,
the network between the two machines must be trusted, because the node API has
no authentication at all — anyone who can reach `POST /api/mining` can stop that
node's miner, and the same address exposes transaction submission, peer
registration and backup download. Keep it on a private network or behind a
proxy that adds auth; do not port-forward it to the internet. Passing both
`--url` and `--port` is rejected rather than picking one, and a path, query
string, credentials or non-http scheme in `--url` is refused before any request
is made.

`doubloom mining status --json` prints the same reading as JSON with fixed types
instead of styled rows, so a script can branch on it without parsing `mining`
versus `paused` out of coloured text:

```json
{
  "node": "http://127.0.0.1:18338",
  "mining": true,
  "address": "moZ3nNSyyqjczkU76DojQhVBULPAY9zKJn",
  "height": 28,
  "difficulty": 1
}
```

`mining` is a boolean, `address` is `null` when the node has no payout address,
and `height` and `difficulty` are numbers. Errors still go to stderr with a
non-zero exit and nothing on stdout, so `out=$(doubloom mining status --json)`
stays parseable when the node is down. Only `status` takes the flag; `pause` and
`resume` keep their prose output.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create the genesis chain and a wallet |
| `info [--json]` | Chain, supply, difficulty, chain work, wallet and backup summary |
| `address` | List wallet receiving addresses |
| `balance [address]` | Confirmed, spendable, immature and pending balance |
| `send <address> <amount>` | Sign a transaction and add it to the mempool |
| `mempool` | List pending transactions |
| `mine [--blocks N]` | Mine blocks, collecting subsidy and fees |
| `mining [status\|pause\|resume]` | Show or change mining on a running node |
| `blocks [--limit N]` | List recent blocks |
| `block <height\|hash>` | Inspect a block |
| `tx <txid>` | Inspect a transaction and its fee |
| `validate` | Replay and validate the entire chain |
| `backup <file>` | Back up the chain and encrypted wallet in one archive |
| `backup now` | Ask a running node to write and verify a backup immediately |
| `backup list` | List archives with their size and the retention tier keeping each |
| `backup status [--json]` | Show the schedule, recovery history, next run, last archive and error |
| `restore <file>` | Restore the chain and wallet from a node backup |
| `wallet new [--label L]` | Add a key to the wallet |
| `wallet list` | List wallet keys (works while locked) |
| `wallet lock` | Encrypt private keys with a passphrase |
| `wallet passphrase` | Re-encrypt the wallet under a new passphrase |
| `wallet unlock` | Decrypt the wallet to plaintext on disk |
| `wallet backup <file>` | Write a verified, gzip-compressed encrypted wallet copy |
| `wallet restore <file>` | Restore a wallet from an encrypted backup |
| `node` | Run the P2P node and block explorer |

Useful options: `--network mainnet|devnet`, `--datadir <path>`, `--address`,
`--from`, `--fee-rate`, `--port`, `--host`, `--announce`, `--peers`, `--seed`,
`--no-seed`, `--mine`,
`--backup-dir`, `--backup-first-delay`, `--backup-first-max-wait`,
`--backup-interval`, `--backup-keep-hourly`, `--backup-keep-daily`,
`--backup-keep-weekly`, `--backup-max-age`, `--backup-recovery-history`,
`--watch`, `--force`, `--json`.

`doubloom info --json` prints the same core fields as `/api/info` plus
`explorer`, `announce`, a `node` object (`running`, `pid`, `port`,
`startedAt`, `mining`), a `backup` object and wallet summary. These are `null` until a
node has run in that data directory. `backup` is `null` until configured;
otherwise it includes the directory, `intervalMs`, a `retention` object
(`hourly`, `daily`, `weekly`), `recoveryHistoryLimit`, `firstDelayMs`, live
`nextRunAt`, `lastBackup`, `lastRecovery` and `recoveryHistory`. Amounts are
decimal DBL strings.

Chain work is reported the same way in both modes, right after difficulty: a
`chain work` row with the total grouped for the operator's locale, and `work` in
the JSON as an exact decimal string. It is the cumulative proof-of-work since
genesis — the figure a node compares to decide which branch wins, and the one
the explorer shows as its Chain work card — so `doubloom info` can be checked
against `/api/info` and the explorer without summing headers by hand. The node
keeps the total cached, so the command reads it rather than re-hashing the
chain. A JSON number would lose precision once the total passes 2^53, hence the
string; the text row is only for reading.

Circulating supply is cached the same way, and for the same reason: it used to be
summed block by block on every `/api/info` request. The subsidy is constant
within a halving epoch, so the total is now kept beside the blocks and advanced
by one subsidy per appended block, with a per-epoch sum — a few multiplications
rather than one addition per height — used when the total has to be rebuilt
(construction, a reorg, a rolled-back extension). At 50,000 blocks the old walk
cost about 1.6 ms per request and at 1,000,000 blocks about 115 ms, growing worse
than linearly as the BigInt total lengthens; the cached read is below the
timer's resolution. The value is unchanged, including the decision to leave the
burned genesis subsidy out of circulation.

## Explorer and HTTP API

The node serves the explorer at `/` and a small JSON API. It is same-origin and
unauthenticated; keep it bound to localhost (the default) unless you know why
you need otherwise. The explorer includes an automatic-backup panel showing
health, the last backup time, the archived height relative to the tip and the
archive's compressed size, the schedule, the latest recovery and the earlier
retained recoveries, plus the archive path, refreshed with the rest of the page.
The size shares the height row (`#122 · 21 blocks behind tip · 1.4 KB · saved 69%`)
and carries the exact byte count in its tooltip (`1,731 bytes gzipped (from
5,669, 69% smaller)`), so the numbers that describe the copy — how much history
it holds, how big it is and what gzip saved — read together. The saving needs
the uncompressed size, which the node records with each archive; a status file
written before that field existed, or an archive whose compressed size already
equals its raw size, simply omits the `saved` part. A countdown
built from the node’s `nextRunAt` ticks every second until the next scheduled
run, with the configured first-backup delay shown beside it and repeated in the
Schedule row so it remains visible without a next run. While the first backup is
held back by peer sync the countdown is replaced by how long it has been waiting
(`waiting for sync 25.5s`), and the note under the panel says the first backup
runs once the initial sync settles. That figure comes from the node as
`syncWaitedMs` (with `syncWaitStartedAt` alongside it in `/api/backup`), and the
page advances it locally each second, so it moves smoothly between the
five-second refreshes without relying on the browser's clock agreeing with the
node's. It disappears as soon as the wait ends rather than climbing on stale data. A small ring draws the
same countdown as a fraction: it fills as the wait elapses — against the first
backup delay before the first archive, against the interval afterwards — and
names the percentage, with the span it measures, in its tooltip. The ring is
hidden while the first backup is still waiting for the initial peer sync,
since there is no meaningful fraction to show yet. If automatic backups are
enabled but no next run is scheduled for a minute, the panel is marked
unhealthy and suggests restarting the node. Its "Back up now" button calls
`POST /api/backup`, which starts the run and answers `202` with a job id; the
button then polls `GET /api/backup/jobs/:id` once a second, counting the seconds
while the archive is written and verified and reporting the resulting height or
error. Nothing is held open for the length of a verification, so the rest of the
page keeps updating meanwhile, and a reload does not lose the run: `GET
/api/backup` includes the newest `job` so the page can resume following it, and
a second request while one is in flight answers `409` with that same job rather
than stacking a duplicate archive. The shell command `doubloom backup now`
drives the same two routes — it follows the job it started and then names the
node, the job id, the archive path, its compressed size, the archived height,
tip and key count, and the next scheduled run. That command resolves the port
from `node.json` when `--port` is omitted, so a node started on a custom port is
still found; a node without `--backup-dir` answers `409` and the CLI says to
restart it with one, and an address with nothing listening is reported as such
instead of as an HTTP error. Below the buttons, **Retained archives** lists every
archive retention has kept, newest first, each a download link labelled with its
UTC time and compressed size and carrying the file name, exact byte count and
timestamp in its tooltip; the newest is marked so the list also answers "which
one did the schedule just write". Under each link sits the archive's SHA-256 and
exact byte count, in one selectable run of text (`sha256 e2f1…2288`), so an
operator can compare a saved copy against `sha256sum` without asking the node
again — the digest's tooltip spells out the command with the file name:

```
2026-10-31 05:52:59 · 1.4 KiB  newest
sha256 e2f1c1ff929a7579a1d21aa7c64703cb7b226bab95af686dc878b26beb332288
```

The list comes from the `archives` array in `GET /api/backup`, so it is the
files actually on disk rather than a history the page remembers, and the whole
block is hidden when there is nothing to offer. Digests are read from disk one
file at a time and cached against each file's size and mtime, so a five-second
refresh costs a lookup rather than re-reading every archive; a listing taken
before that read finishes reports `sha256: null` and the panel shows `sha256
computing…` until the next refresh fills it in. A rewritten archive is hashed
again rather than reported with its old digest, and sums for archives retention
has removed are dropped.
One row after
the schedule names the node itself, as `Node` followed by the pid and the URL
peers were told to use on a single line:

```
Node      pid 10800 · http://192.168.12.82:18338 · up 2h 14m
```

The parts belong together — two nodes on one machine share the name, so the pid
and the announced address are what tells their panels apart — and the address is
the one that can be long, so only it shrinks: at 380 px wide with a long
hostname the row stays a single line, the address ellipsizes, and the pid and
uptime keep their width. Both values come from `/api/info`, so they stay correct
on a node without backups, follow an address change while the node runs, and
leave no dangling separator when a node has announced nothing.

The uptime is a counter, not a timestamp: the page keeps `startedAt` from
`/api/info` (epoch milliseconds) and advances it locally every second between
the five-second polls, so it keeps moving even while a request is in flight and
costs the node nothing. It reads `12s`, then `4m 07s`, then `2h 14m`, then
`3d 4h` — two units, seconds only while the node is young, and a zero second
unit dropped so an hour-old node reads `1h` — and its tooltip says
`up since 2026-10-31 07:34:53 UTC`. A node that restarts is picked up on the
next poll, since the counter is derived from the node's own start time rather
than from when the page first loaded. Digits are tabular, so the row does not
shift as the number changes.

`/api/info` also reports `work`, the cumulative proof-of-work since genesis, as
an exact decimal string (it outgrows a JavaScript number once difficulty rises).
The chain keeps that total alongside its blocks — a validated block adds its own
work, a reorg replaces the total with the one it compared — so neither this
endpoint nor a peer comparison re-sums every header; on a 50,000-block chain
that sum costs about 86 ms per call.
The explorer shows it as the Chain work card, which is the quick way to spot a
reorg without reading logs: when a node adopts a heavier peer chain, the tip and
the work figure both jump to the other branch's values, and a node that ignored
an equal-or-lighter chain keeps its own. Work below 15 digits is grouped with
commas; larger values are shortened to an exponent form with the exact figure in
the tooltip.

When a node does adopt a heavier branch, the explorer says so: a strip under the
header reads `Chain switch · fork at #N · new tip #M <hash>… · Ns ago`, with the
number of blocks adopted, the peer and the full tip in its tooltip. It is driven
by `/api/info`'s `lastReorg` (`at`, `forkHeight`, `height`, `tip`, `added`,
`peer`), which stays `null` until the node first replaces its own branch, so a
node that is simply extending shows nothing. The strip disappears ten minutes
after the switch, and it is in-memory only: restarting the node clears it.

| Route | Description |
| --- | --- |
| `GET /api/info` | Network, height, tip, difficulty, chain work, supply, mempool, peers, per-peer byte totals, discovery, announced address, last reachability result, pid, last reorg |
| `GET /api/backup` | Backup schedule, recovery history, next run, last archive and newest job |
| `POST /api/backup` | Start a verified backup now; answers `202` with a job (`409` when one is already running) |
| `GET /api/backup/jobs/:id` | One backup job: `state` (`running`, `succeeded`, `failed`), the archive, or the error |
| `GET /api/backup/download` | The newest verified archive as a gzip attachment (`409` without backups, `404` before the first one) |
| `GET /api/backup/archives/:name` | Any retained archive by name, as a gzip attachment (`409` without backups, `404` for a name retention would not keep) |
| `GET /api/backup` `archives[]` | Each retained archive's `name`, `bytes`, `at` and `sha256` (`null` while the file is still being read) |
| `GET /api/mining` | Mining state, payout address, height and difficulty |
| `POST /api/reachability` | Ask this node to dial a node URL (`{"url": "http://host:port"}`) |
| `POST /api/mining` | Start or stop the miner (`{"enabled": true\|false}`) |
| `GET /api/blocks?limit=N` | Recent block summaries |
| `GET /api/blocks/:heightOrHash` | One block with its transactions |
| `GET /api/chain` | Chain blocks (full, or only those after `?locator=`, used by peer sync) |
| `GET /api/tx/:txid` | Confirmed or pending transaction |
| `GET /api/address/:address` | Balance, UTXOs and pending funds |
| `GET /api/mempool` | Pending transactions with fee rates |
| `GET /api/peers` | Known peers |
| `POST /api/tx` | Validate, store and relay a signed transaction |
| `POST /api/block` | Validate, connect and relay a block |
| `POST /api/peers` | Register a peer |

Both download routes copy the file; the node keeps its own archive for
retention. `/api/backup/download` serves only the archive the scheduler recorded
as verified, and `/api/backup/archives/:name` serves any file the retention
pattern accepts — so an older retained archive is downloadable, while a name
outside that pattern, a path traversal or an unrelated file in the directory
answers `404` and nothing outside the backup directory is ever read. A file
literally named in the status but deleted from disk answers `404` on both
routes rather than failing mid-stream.

## How it works

```
src/
  params.js       consensus parameters (mainnet and devnet)
  hash.js         SHA-256d, RIPEMD-160 (with a pure-JS fallback), hash160
  base58.js       base58 and base58check
  keys.js         secp256k1 keys, signing, base58 addresses
  amount.js       DBL ↔ petal conversion
  transaction.js  UTXO transactions, sighash, fee and signature validation
  block.js        headers, merkle roots, compact targets, mining
  chain.js        consensus rules, UTXO set, difficulty, mempool, reorgs
  wallet.js       key storage, coin selection, change and fee calculation
  wallet-crypto.js  scrypt key derivation and AES-256-GCM key encryption
  passphrase.js   hidden passphrase prompt for the CLI
  store.js        chain/mempool persistence
  backup.js       whole-node backup archive, verification and restore
  backup-scheduler.js  periodic verified backups with retention
  backup-thread.js / backup-worker.js  backups off the node's event loop
  peer-discovery.js  DNS seed resolution for automatic peer bootstrap
  node-state.js   the addresses a running node announces, persisted for info
  node.js         HTTP node, peer sync/relay, miner, explorer host
  explorer.html   block explorer UI
  cli.js          command-line interface
```

**Blocks.** Each block has an 80-byte header (version, previous hash, merkle
root, timestamp, compact difficulty, nonce) and a list of transactions. The
merkle root commits to all transaction ids; the header hash must be at or below
the target. Mining increments the nonce (and the timestamp on wrap-around).

**Difficulty.** Every 2,016 blocks the node compares the actual timespan of the
window with the expected 14 days and scales the target, clamped to a factor of
four either way. The easiest allowed target is the proof-of-work limit. Devnet
retargets every 20 blocks with a 60-second target for fast testing.

**Transactions.** Each input spends an outpoint (`txid:vout`) and carries a
public key plus a DER signature over the whole transaction, the input index and
the value/address being spent. Outputs pay to a RIPEMD-160(SHA-256(pubkey))
hash. Validation enforces signatures, no double spends, coinbase maturity,
positive output values, the supply cap, minimum relay fees and, for blocks, that
the coinbase pays at most subsidy plus fees.

**Wallet.** `data/<network>/wallet.json` holds independent secp256k1 keypairs.
The wallet selects UTXOs largest-first, pays a size-based fee with a small margin
for DER length variance, and returns change to the sending address (change below
546 petals is left to the miner).

**Wallet encryption.** `wallet lock` converts the wallet to version 2: each
private key is encrypted separately with AES-256-GCM under a key derived from
the passphrase with scrypt (N=32768, r=8, p=1, 32-byte key, random 16-byte
salt). The network and address are authenticated as additional data, so a
ciphertext cannot be moved to another entry. Addresses, public keys and labels
stay readable, which is why `address`, `balance`, `wallet list` and mining to a
wallet address work while locked; only signing needs the passphrase.

`send` and `wallet new` prompt for the passphrase when the wallet is encrypted,
decrypt the keys into memory, and leave the file on disk encrypted. `wallet
unlock` is the explicit convenience form: it prompts once and rewrites the
wallet in the version 1 plaintext format, after which signing needs no
passphrase until `wallet lock` runs again.

`wallet passphrase` changes the passphrase of an encrypted wallet in place. It
verifies the current passphrase, derives a key from the new one with a fresh
salt, re-encrypts every private key, decrypts each new ciphertext back to check
it, and only then atomically replaces the file. The wallet stays in the
encrypted version 2 format for the whole operation; nothing is ever written in
plaintext, and the old passphrase stops working as soon as the new file lands.

`wallet backup <file>` writes the encrypted wallet to another path, gzipped,
then loads that written copy back through the restore path — decompressing it
and decrypting it with the passphrase; a successful command is evidence that the
backup is usable, not just that bytes were copied. `.gz` is appended to the path
unless it already ends that way, and the command prints the archive name, the
compressed size and the uncompressed one. It refuses to overwrite an existing
file and refuses plaintext wallets, so run `wallet lock` first if necessary.
The export is the same ciphertext as the live wallet, not a second encryption
layer, and it must be stored separately from the passphrase.

Compression is detected from the file contents on read, so a wallet backup
written as plain JSON before compression existed still restores, and the
installed `wallet.json` is always the uncompressed format the rest of the tool
reads — decompression happens on the way in, never as a gzipped wallet file.

`wallet restore <file>` verifies the backup’s passphrase and format, writes it
to a temporary file, decrypts that file again, and only then renames it into
place. It will not replace an existing wallet unless `--force` is passed. The
restored wallet keeps the passphrase it had when the backup was made.

**Node backups.** `backup <file>` writes one gzip-compressed JSON archive
containing every confirmed block and the encrypted wallet. `.gz` is appended to
the path unless it already ends that way, and the command prints the actual file
name and both sizes. The chain snapshot is replayed and every block validated,
the wallet is unlocked to prove the passphrase, and the finished archive is read
back — decompressed, re-validated and decrypted — before the command reports
success. It refuses plaintext wallets for the same reason wallet backups do.
Mempool transactions are intentionally excluded: they are not part of the
ledger, and a stale pending payment should not reappear after a restore.

`restore <file>` validates the entire archive before writing anything, then
installs `chain.json` and `wallet.json` together. Compression is detected from
the file itself, so archives written as plain JSON before compression existed
still restore unchanged. It refuses to touch existing
node data unless `--force` is passed, so a restore cannot silently destroy a
live wallet. Stop any node using the data directory before restoring, and note
that the chain is public while the wallet is encrypted; the archive as a whole
is not additionally encrypted.

**Automatic backups.** `node --backup-dir <path>` schedules the same verified
archive while the node runs: one after `--backup-first-delay` seconds (default
10, or the interval when that is shorter), then every `--backup-interval`
minutes (default 60, decimals allowed), retaining archives in three tiers and
keeping the newest `--backup-recovery-history` recovery events (default 5).
The first backup also waits for the node’s initial peer
sync pass to finish, so `--backup-first-delay` is an earliest start rather than
a guarantee; a node with no peers proceeds after the delay. That wait is
capped by `--backup-first-max-wait` seconds (default 300), measured from the
first readiness check that finds sync unsettled rather than from startup, so
the configured delay is not spent out of the cap. A peer that accepts a
connection and never answers would otherwise postpone the first archive
forever; instead the node writes one at whatever height it has reached and says
so:

```
First automatic backup: peer sync has not settled after 5m 1s (limit 5 min); writing an archive anyway
```

The cap applies to the first backup only — later runs follow the interval
regardless of sync state — and `--backup-first-max-wait 0` removes it for a node
that must never snapshot a chain that is still filling in. The startup log
reports the cap with the other backup settings (`sync wait cap 5 min`, or
`First automatic backup waits for peer sync to settle indefinitely` when it is
switched off), and `doubloom backup status` and `doubloom info` show it beside
the next run (`· sync wait cap 5 min`, or `· sync wait uncapped`). A ten-second
watchdog re-arms the timer if the schedule ever loses its next run, logging
`Automatic backup schedule re-armed`. If the last successful archive is already
overdue, the recovered run starts immediately; otherwise it preserves the
remaining interval. The startup summary prints the directory, interval,
archive retention, recovery-history depth and age limit. It requires an encrypted wallet
and asks
for the passphrase at startup; that passphrase stays in the node process so each
scheduled backup can be verified without another prompt. Archives are named
`doubloom-<network>-backup-<UTC timestamp>.json.gz`, and only files matching
that pattern (including the older uncompressed `.json` names) are pruned, so
unrelated files in the directory are left alone. The byte size recorded in the
status, the node log, the explorer and the API is the compressed size on disk.

**Automatic verification.** Writing and validating an archive proves it was sound
at the moment it was written, not that the file on disk still is. Unless
`--backup-verify-interval 0` disables it, the node also restores the newest
archive into a fresh temporary directory every `--backup-verify-interval`
minutes (default 360, i.e. six hours), replaying its chain and unlocking its wallet with the node
passphrase; the directory is removed again either way. A restore that fails is a
warning naming the archive and the passphrase-change possibility:

```
warning: the newest backup could not be verified: doubloom-devnet-backup-20261031-043739638.json.gz (backup at … is not valid JSON); the archive may be corrupt or the wallet passphrase may have changed
```

A corrupt archive is only reported once, however often the check runs, and a
successful check afterwards says so (`backup verification recovered: … now
restores cleanly`). Each check runs on the backup worker thread, so the chain
replay and scrypt unlock do not stall peers, the API or the explorer.

Retention is tiered rather than a single count. After each backup the scheduler
keeps the newest archive of each of the last `--backup-keep-hourly` hours
(default 24), `--backup-keep-daily` days (default 7) and `--backup-keep-weekly`
ISO weeks (default 4), and deletes everything else that matches the archive
pattern. The three tiers are computed independently and unioned, so the newest
archive usually fills its hour, day and week at once and a dense schedule
collapses to one archive per day as it ages. Set a tier to `0` to drop it;
`--backup-keep-hourly 0 --backup-keep-daily 0` leaves only weekly archives.
The older `--backup-keep <count>` flag is rejected with a pointer to the tier
flags, and a status file from before tiers is read as "keep this many hourly
archives" so an upgrade does not discard history it already had.

`doubloom backup list` shows what is actually on disk, newest first, with each
archive's size and the tiers that keep it:

```
Archives /srv/doubloom/backups · times UTC

  2026-10-31 04:39:08.479    1,001 B  hourly · daily · weekly
  2026-10-30 04:39:08.479    1,011 B  hourly · daily
  2026-10-22 06:39:08.479    1.1 KiB  weekly
  2026-09-21 06:39:08.479    1.4 KiB  prunable

  4 archives · 4.4 KiB total · keep hourly 2 · daily 2 · weekly 2; archives no tier keeps are pruned after the next backup
```

The directory comes from `--backup-dir` or from the schedule the node recorded,
so a stopped node's archives can be inspected without restarting it, and the
retention in force is the recorded one rather than a guess. An archive that no
tier selects is still listed, marked `prunable`: it exists now, and the next
backup is what removes it. Only files matching this network's archive pattern
count, so anything else in the directory is ignored rather than reported as an
archive. Timestamps carry milliseconds, which is what keeps two archives written
in the same second distinct.

`--backup-max-age <min>` sets how old the newest archive may get before the node
complains; it defaults to twice the interval, with a floor of one minute. A
ten-second watchdog checks the age and warns once per stale episode, so a stalled
schedule is loud without being repeated on every tick:

```
warning: the last automatic backup is 2.1 h old, past the 2 h limit; automatic backups may have stopped
```

The warning is not left as the last word: when a run replaces an archive that
was already past the limit, the node logs the recovery too, so a log with the
warning in it also shows whether the problem cleared on its own.

```
backup schedule recovered: the previous archive was 8.0s old, past the 3s limit; fresh archives are being written again (height 3)
```

It is measured against the archive being replaced rather than the in-process
warning flag, so a node restarted with an already-stale archive reports the
recovery on its first new archive as well. The line is written after
`backup written` (which reports the file, height and any pruned archives), is
emitted once per stale episode rather than on every run, and goes to stdout
like other successes — the watchdog's warning stays on stderr.

The warning re-arms after the next successful backup, and the explorer's
`overdue` state uses the same configured limit rather than its own rule, with
the measured age and the limit shown in the note. `doubloom backup status`
reports the limit alongside the rest of the schedule.

Age is not the only way an archive goes stale, so the panel also watches the
height: when the newest archive is more than six blocks behind the tip — a full
interval of history at ten-minute blocks — it reads `behind tip` with the gap,
the limit and the archive height spelled out, even though the age limit has not
been reached. The check is ordered after the age rule, so an archive that is
both older than the limit and far behind still reads `overdue`, and a failed
attempt still reads `last attempt failed`; the flag clears as soon as a backup
lands at the tip. The Archived height row already reports the same gap, so the
number in the note is the one beside it rather than a second measurement.

A failed backup is logged and the schedule continues; it never stops the node.
On a running node the whole job — snapshot, gzip, then reading the archive back
and re-validating it (chain replay and scrypt) — runs on a worker thread, so
peers, mining, the API and the explorer keep answering while a large chain is
backed up. One thread is started on the first job and reused for every later
backup and for the periodic verification, so an hourly schedule does not pay a
thread spawn and a module load per archive. It is stopped when the node closes,
but only once an archive already being written has finished: a shutdown waits
for that last file rather than terminating the thread mid-write and leaving a
truncated backup behind. The passphrase is passed to that thread in memory and never written
anywhere. Both a scheduled run and `POST /api/backup` take the same path,
including the `running` guard: a second request while one is in flight answers
`409`. The one-shot `doubloom backup` command stays in-process, since it has no
node to keep responsive. Stop the node before
restoring one of its archives.

Each attempt updates `backup-status.json` next to the chain with the last
successful archive’s time, height, tip, byte size and path, plus the most recent
error if one occurred. `GET /api/backup` returns that record while the node is
running (`{ "enabled": false }` when no schedule is configured), along with
`nextRunAt`, `running`, `waitingForSync`, `syncWaitStartedAt` and `syncWaitedMs`
(how long the first backup has been waiting for peer sync, both `null` when it
is not), `firstDelayMs`, `firstMaxWaitMs`, the `retention` tiers, `lastRecovery`,
`recoveryHistory` and `recoveryHistoryLimit` for the live schedule.
`lastRecovery` is the newest recovery or `null`; `recoveryHistory` lists the
most recent recoveries up to the configured depth, newest first, each with `at`
and `reason`. The node prints the last and next scheduled backup at startup,
with
the configured first-backup delay beside the next time, while `doubloom info`
shows a `backup config` line with the interval, archive retention and recovery
depth, a `last recovery` line plus any earlier retained recoveries, a
`last backup` line and, while the owning node process is still alive, a
`next backup` line with the same delay plus a countdown to it, in the same
`(in 9m 58s)` form `backup status` uses. The countdown carries two units (days
and hours, hours and minutes, or minutes and seconds), so it distinguishes a run
five minutes away from one fifty minutes away instead of rounding both to
`in 1h`; while the first backup is still waiting for the node's initial sync the
parenthesis says `waiting for sync` instead.
The status file stores the next run time, the recent recovery history and the
owning PID, but no keys or passphrase; the PID check keeps `info` from reporting
a schedule after the node has exited. `doubloom backup status` prints the same record in more detail:
node state, interval, retention and recovery depth, directory, the configured
first-backup delay alongside the next run and its countdown, the last archive's
clock time with how long ago it was taken, its path, height and size, the
retained recovery times and reasons, and the last error with its attempt time. It reports
`not configured` when no automatic backup has ever been set up in that data
directory.

`doubloom backup status --json` prints the same record as one JSON object for
scripts: `network`, `statusFile`, `configured`, `running` (whether the recorded
pid is alive, so callers do not reimplement that check), `pid`, `directory`,
`intervalMs`, `firstDelayMs`, `firstMaxWaitMs`, `maxAgeMs`, `retention`,
`recoveryHistoryLimit`, `nextRunAt`, `waitingForSync`, `lastAttemptAt`,
`lastError`, `lastBackup`
(`at`, `height`, `tip`, `path`, `bytes`, `keys`), `lastRecovery` and
`recoveryHistory`. Timestamps stay ISO-8601 as stored, so nothing is rounded or
localised, and a data directory without a status file still prints a complete
object with `configured: false` and nulls rather than failing — a script can
branch on `configured` instead of parsing text or catching an error. The plain
output is unchanged and remains the default. When the recorded pid is gone,
`nextRunAt` and `waitingForSync` are `null`/`false` even though the status file
still holds the timestamp the dead node intended: that run will never happen, and
`lastBackup` is kept so a stopped node's last archive is still readable.

`doubloom backup status --watch` keeps that panel on screen and redraws it once a
second, so the countdown to the next run moves and a re-armed schedule or a fresh
archive appears without re-running the command. On a terminal it redraws in
place — the cursor is moved back over exactly the lines it printed last time — so
the rest of the scrollback is left alone, and the cursor is restored on Ctrl+C.
It ends by itself when the node it is watching exits, saying `node stopped; watch
ended`; a data directory whose recorded node has never been running says
`waiting for a node to start with --backup-dir` and keeps waiting, so the watch
can be started before the node. Piped output is a log rather than a display, so
it prints a new panel only when the record changes instead of one identical copy
per second, and carries no cursor control. `--watch` and `--json` are different
jobs — a live panel and a single machine-readable record — so asking for both is
a usage error.

`POST /api/backup` runs one backup immediately, using the same verified archive
and retention rules. It returns the archive summary and updated status, `409` if
no schedule is configured or another backup is already running, and `500` if the
backup itself fails. Like a scheduled run, it performs full chain validation on
the node’s event loop, so RPC and mining pause briefly while it works.

Passphrases are never taken as command-line arguments; scripts can set
`DOUBLOOM_PASSPHRASE` for the current (or, with `wallet lock`, the new)
passphrase, and `DOUBLOOM_NEW_PASSPHRASE` for the replacement used by `wallet
passphrase`. Environment variables are visible to other processes owned by the
same user. There is no recovery mechanism and no passphrase hint stored in the
file: if the passphrase is lost, the keys cannot be decrypted.

**Persistence.** `data/<network>/chain.json` holds the chain and mempool. The
UTXO set and transaction index are rebuilt and re-validated from the blocks on
load, so a corrupted chain fails loudly rather than being trusted.

## Where Doubloom differs from Bitcoin

Doubloom follows Bitcoin's monetary and consensus design, but it is a compact
reimplementation, not a fork or a drop-in replacement:

- Transactions and blocks are serialized as canonical JSON, not Bitcoin's
  custom byte encoding, so txids and hashes differ from Bitcoin's format.
- Only pay-to-public-key-hash is supported. There is no script language,
  multisig, timelock, SegWit, Taproot, Lightning or Replace-By-Fee.
- Peers speak HTTP/JSON and sync full blocks; Bitcoin uses a binary TCP protocol
  with inv/getdata and compact block relay.
- Storage is a JSON file, not LevelDB, and the wallet is a flat key list rather
  than an HD wallet (no seed phrase or derivation path). Wallet encryption is
  passphrase-based only; there is no hardware-wallet, multisig or offline
  signing support.
- Mainnet genesis difficulty is deliberately low (about 2¹⁶ hashes) so a brand
  new network can bootstrap; the normal retarget rules raise it as blocks arrive.
- Devnet changes only the retarget interval, block target and address prefix.

## Tests

```bash
npm test
```

That is the command CI runs: `.github/workflows/test.yml` executes `npm test` on
Node 18.x and 20.x for every push, on any branch — the oldest version
`engines.node` allows and the current LTS. The two legs run independently
(`fail-fast: false`), so a break on the minimum version is reported as that,
rather than cancelling the leg that still passes. The suite is green on both:
109 tests on Node 18.20.8 as well as on Node 20.18. The project has no
dependencies, so the workflow has no install step and needs no lockfile; add
`npm ci` and commit a lockfile if dependencies ever appear. The suite uses only
Node's built-in test runner and temp directories, so it runs the same on Linux,
macOS and Windows.

The suite covers key generation and signatures, genesis determinism and
proof-of-work, the halving schedule and supply cap, payments and fees, coinbase
maturity, double-spend/signature/low-fee rejection, malformed blocks, reorgs by
cumulative work, difficulty retargeting, transactions chained within one block,
and wallet encryption: ciphertext secrecy, authenticated-data binding, wrong
passphrase rejection, in-place passphrase rotation, wallet and whole-node
backup verification and restore, scheduled backups with configurable first
delay, sync-gated warmup and retention, persisted next-run and backup status
reporting, failure isolation, overwrite refusal, tampered-chain rejection, and
the lock/unlock format conversion.

## Benchmarks

`npm run bench` measures what a longer chain costs. It grows a real devnet chain
by actual proof-of-work in-process while a node serves requests from it, then
reports three numbers at each sampled height:

```bash
node bench/growth.js [--heights 1000,10000,50000] [--samples 25]
```

```
      height     mined    work cached   work rebuild    info p50    info p95
       1,000      0.6s      0.0002 ms      2.2730 ms     2.53 ms     4.00 ms
      10,000      4.4s      0.0000 ms     22.2964 ms     1.70 ms     2.95 ms
      25,000      6.8s      0.0000 ms     49.9349 ms     1.50 ms     4.15 ms
```

- **work cached** is `chain.work`, the total maintained beside the blocks. It
  is a field read, so it stays flat as the chain grows.
- **work rebuild** is `cumulativeWork(blocks)` — what computing the total from
  the headers costs, which is what `/api/info` used to pay per request. It grows
  with height, which is the cost the cache removes.
- **info** is the p50 and p95 of `GET /api/info` round trips against the local
  node, after a warm-up. It is HTTP-bound on loopback, so it says whether the
  endpoint stays flat rather than what the handler costs in isolation.

The benchmark needs its own clock. A retarget window compares the span between
its first and last block against `retargetInterval * targetBlockTime`, and that
window holds one gap fewer than there are blocks, so blocks spaced at exactly
the target block time make every retarget see a short span and raise difficulty
by that fraction — 5% per retarget on devnet, which compounds into a chain that
cannot be mined within a few thousand blocks. The script instead walks a
repeating gap pattern that sums to exactly one window's expected span (63s and
64s gaps on devnet), so every window is a rotation of it, the ratio is always 1
and difficulty stays at the genesis floor. It aborts rather than reporting
numbers if the difficulty drifts.

That has two consequences worth knowing when reading the table. Difficulty at
the floor means each header contributes a single unit of work, so the totals are
smaller than a mature chain's would be and the BigInt work per addition is
correspondingly cheaper — the growth pattern is representative, the absolute
numbers are optimistic. And devnet is the only network used, because mining is
free there; growing a mainnet chain to these heights would take hours of hashing
to measure something already visible here.

### Hashrate and what it is worth

`npm run hashrate` measures how fast this machine actually hashes an 80-byte
header — once exactly as the node's miner does, and once tuned — then converts
the rate into the figures that decide whether mining pays: the share of
Bitcoin's network it represents, the pool payout that share earns in a day, what
the same hours cost in electricity, and the coin price needed to break even.

```bash
node bench/hashrate.js [--seconds 2] [--network-hashrate 800] [--watts 95] [--kwh 0.15]
```

The rates are measured on the machine running it; the network hashrate, power
draw and electricity price are inputs. On a 2012 laptop CPU the answer is 78
kH/s, a share of the network around 10⁻¹⁶, and a break-even price in the
trillions — the point being that general-purpose hardware stopped being a
Bitcoin miner when ASICs arrived. [docs/mining-on-your-own-hardware.md](docs/mining-on-your-own-hardware.md)
takes that measurement and the recipe for running several nodes' miners on one
chain across machines you own, with the regtest equivalent for real Bitcoin.
