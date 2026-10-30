# tl-orderbook

A std-only Rust port of the TradeLayer **external orderbook server** (`tl-orderbook-server`), with a legacy
parity harness and Lean 4 proofs of the matching, lifecycle, authorization and swap-step logic.

**This is not consensus matching.** It ports the off-chain service that pairs wallets for atomic swaps:
order events, price-time-priority matching, the swap request built for each match, the settlement
lifecycle of an order, and the socket protocol around it. The chain's own order matching lives in
`tradelayer-core` and is out of scope. Nothing here talks to a network, a disk or a clock; the transport
(socket.io/fastify), log files and TLS are an adapter boundary (see "Not ported").

- Baseline: `master` @ `909332c62a3ccf98413cbfe125e264f35bdb7a30`, branch `feat/rust-port`.
- No dependencies (`[dependencies]` is empty), `#![forbid(unsafe_code)]`, Rust 1.90.0 pinned.

## Inspected legacy sources (source of truth = the `.ts`)

| file | blob |
|---|---|
| `src/services/orderbook/orderbook.class.ts` | `9f4b839a` |
| `src/services/orderbook/manager.class.ts` | `4e76044c` |
| `src/services/orderbook/order.factory.ts` | `884d3f93` |
| `src/services/socket/manager.class.ts` | `ca924c4b` |
| `src/services/socket/events.ts` | `00ed89b9` |
| `src/services/channel-swap/channel-swap.class.ts` | `4819e0f3` |
| `src/utils/types/{orderbook,markets,mix}.types.ts`, `src/utils/pure/mix.pure.ts` | `35fa49cd`, `db42133d`, `fbfdb1ab`, `7b8a9294` |

The `.js` files are `tsc` output (ES5 `__awaiter`/`__generator`); I compared `checkMatch`, `addOrder` and
`buildTrade` in `orderbook.class.js` against the `.ts` by reading and found them identical in logic. The
compiled `.js` (`d5496223`) is used only to *run* legacy code in the parity harness. The wallet-side step
names (`SELLER:STEP1` ... `BUYER:STEP6`) come from the public `tradelayer-wallet` swapper
(`packages/wallet-fe/src/app/utils/swapper/{buyer,seller}.ts`), because the relay itself only looks at
`BUYER:STEP6` and `TERMINATE_TRADE`.

### `origin/rust-refac` is not a pure TS refactor

`git diff master...origin/rust-refac --stat`: 40 files, +6473/-1435. Tip `9c2f873` (2025-12-02). It contains Rust:
`rust/matcher-core` (a napi-rs `cdylib`, `src/lib.rs` 1238 lines, f64 prices integerised with a price scale,
self-trade-prevention policies "STPF maker-bump / neutralize-taker", `cancel_all_by_socket`, `edit`,
`submit_batch`), which depends on `../OrderBook-rs` (shipped as a 438 KB `rust/OrderBook-rs.zip`), plus a
committed prebuilt `matcher_core.node` binary (1.4 MB), a stray empty file `rust/matcher-core/cp`, a hard-coded
log path `/mnt/c/Users/patri/Downloads/tl_ob.log`, and `rust_test.js`. The TS side was rewritten onto
`hyper-express` (`socket/manager_class.ts`, 1499 lines) and `orderbook/*.ts` was deleted. It also carries
"network-keyed orderbooks, tradeId in swap" commits. I did **not** use it as a basis: it changes matching
semantics (self-trade prevention instead of the legacy same-account error), pulls in an unreviewed external
engine and a binary artifact, and has no tests. The `tradeId` idea is adopted here as the server-assigned
`TradeId` that binds swap messages; network-keyed books are left as an unresolved question.

## What was ported

| TypeScript | Rust |
|---|---|
| `orderbook.types.ts` (`TOrder`, `ISpot/IFuturesOrderProps`, `ITradeInfo`, `IHistoryTrade`) | `types.rs`, `book.rs` (`Order`, `Props`, `TradeInfo`, `TradeProps`, `HistoryTrade`) |
| `mix.pure.ts` `safeNumber` | `amount.rs` (`Amount`, `Price`, `notional`) |
| `Orderbook.checkCompatible` / `findByFilter` / `orderbookName` | `MarketKey::{compatible, matches_filter, name}` |
| `Orderbook.checkMatch` | `Orderbook::find_match` |
| `buildTrade` | `build_trade` |
| `Orderbook.addOrder` | `Orderbook::submit` (up to the channel) + `complete` / `abort` (after it) |
| `Orderbook.removeOrder` | `Orderbook::cancel` |
| `OrderbookManager` | `manager.rs` `OrderbookManager` (many markets, trade-id routing, per-session views) |
| `ChannelSwap` | `swap.rs` (`SwapKind`, `SwapMsg`, `SwapState::on_message`) |
| `OnEvents` / `EmitEvents` / `OrderEmitEvents`, `SocketManager`, `onNewOrder` ... | `socket.rs` (`ClientEvent`, `ServerEvent`, `SessionManager`, `Server`) |
| order log files ("FILLED"/"CANCALED") | `lifecycle.rs` (`OrderState`, `LifecycleEvent`) kept in a bounded in-memory log |
| (new) | `validate.rs` (`Limits`, `validate`) |

Order lifecycle (`lifecycle.rs`, 8 allowed edges, `Settled`/`Cancelled` terminal):

```
New -> Open -> LockedInSwap -> Settled
 |      |  ^        |  |
 |      |  +--------+  +--> Cancelled (taker's swap failed)
 |      +--> Cancelled (owner close / disconnect)
 +--> LockedInSwap (taker crosses immediately), New -> Cancelled (batch crossing)
LockedInSwap -> Open is the unlock edge (swap not settled, or a partial fill leaves a remainder)
```

## Scale and rounding

Amounts and prices are `u64` counts of 1e-6 units (`SCALE = 1_000_000`), at most `MAX_RAW = 1e9` whole units.
Legacy values are JS doubles rounded with `parseFloat(n.toFixed(6))`; six decimals is therefore the legacy
contract. Subtraction is exact. `amount * price` is computed exactly in `u128` and rounded **half-up** to six
decimals, which is `toFixed(6)` applied to the exact decimal product. JS computes in doubles, so the two
agree only in the *safe domain*: inputs with at most six decimals and modest magnitude (the parity fixtures use
amounts in multiples of 0.001 and prices in multiples of 0.01). Outside it the Rust value is the exact one
and may differ from the legacy double result in the last digit. `Amount::from_f64_exact` converts a double only
when it is exactly a six-decimal number. 1e-8 (satoshi) precision is **not** representable; see open questions.

## Compatibility table

| # | status | legacy | new behaviour | test |
|---|---|---|---|---|
| P1 | preserved | `orderbook.class.ts:148-186` crossing filter, best price, stable-sort ties, `[0]` | `Orderbook::find_match`: lowest/highest price level, smallest sequence number in it (= first minimum in book order) | `tests/parity.rs` (319 cases vs legacy), `tests/index_differential.rs` (index vs linear scan) |
| P2 | preserved | `:312-367` `buildTrade`: fill `min(amounts)` at the **maker's** price, `unfilled` remainder | `build_trade` | parity, `protocol.rs` |
| P3 | preserved | `:178-184` best candidate from same socket / same address fails the whole submission (next-best is not tried) | `Error::SameAccount` / `SameAddress`, same text | parity (`final error=`), `same_session_best_match_blocks_the_taker_like_legacy` |
| P4 | preserved | `:208` `many-orders` crossing order is silently dropped; `socket/manager.class.ts:75-80` | `SubmitOutcome::Skipped`, logged as `BatchCrossing` | `many_orders_places_resting_and_silently_skips_crossing` |
| P5 | preserved | `:136` history = newest first, 2000 | `history_cap = 2000` | `d3_history_and_order_log_are_capped` |
| P6 | preserved | `onNewOrder` rejects non-limit orders; `onUpdateOrderbook` hides locked orders | same | `market_orders_are_rejected`, `update_orderbook_hides_locked_orders...` |
| D1 | repaired defect | `orderbook.class.ts:218-220` + `channel-swap.class.ts:47-55`: the maker's order is **deleted** when `TERMINATE_TRADE`'s *payload* `socketId` equals the maker, so a taker could delete any maker's order by claiming to be it; the relay listens on every `${id}::swap` for both sockets | The actor is the authenticated session, never a payload field. An unsettled swap only **unlocks** the maker order (never removes it); only the owner's explicit `close-order` (or disconnect) cancels | `d1_*` (4 tests) |
| D2 | repaired defect | `socket/manager.class.ts:90-100` no size check: a dust order at the best price is matched first by everyone and each fill costs a full on-chain swap | `Limits::min_amount` (0.001) on entry; a remainder below it is dropped and accounted (`FilledDust`, `fill + live + dust = original`) | `d2_*` |
| D3 | repaired defect | unbounded `orders`, unbounded `many-orders` loop (`:75`), unbounded sessions, unbounded swaps | caps: orders per session (100), resting orders per side (1000), batch (100), books (64), sessions, total and per-session swaps, outbox, history/log | `d3_*` |
| D4 | repaired defect | `channel-swap.class.ts:44-62`: steps are relayed with no order, no sender check, no trade binding; `BUYER:STEP6` from anyone settles; STEP5 is not bound to STEP4 | each message names its `TradeId`; sender = session; odd steps seller, even steps buyer; step *n* only after step *n-1*; STEP6 payload must be a 64-hex txid; payload size cap; finished trades reject replays | `d4_*`, `swap.rs` tests, Lean `step5_needs_step4`, `settle_needs_all_six` |
| D5 | repaired defect | no validation beyond `isLimitOrder` | `validate`: positive amount/price, minimum size, notional in range, keypair shape, market-name length, spot pair must differ, leverage in (0, 1000] | `d5_validation_rejects_malformed_orders` |
| D6 | repaired defect | `channel-swap.class.ts` promise resolves only on STEP6/TERMINATE, so a silent counterparty keeps the maker locked | `Limits::swap_timeout_ms` (10 min), `Server::tick(now)` with an injected clock unlocks and notifies both sides | `d6_*`, `timeout_unlocks_makers_and_tells_both_sides` |
| D7 | repaired defect | `:287-304` `removeOrder` has no lock check: the owner can delete an order mid-swap | `Error::OrderLocked` | `d7_*`, Lean `cancel_authorized` |
| D8 | repaired defect | `:234-235` `return { data: res.data }` drops the error of the remainder's re-add; `onClosedOrder` ignores `removeOrder` errors | the error goes to the order's owner as `order:error`, the remainder is cancelled with a lifecycle event; failed `close-order` is reported | `d8_*` |
| V1 | versioned protocol change | order id is a uuid string, session id a socket-id string | `OrderId(u64)`, `SessionId(u64)`, `TradeId(u64)` assigned by the server/transport | - |
| V2 | versioned protocol change | swap events are named `${socketId}::swap` and carry no trade id | `ClientEvent::Swap(SwapMsg{trade_id,kind,payload})`; `new-channel` carries `trade_id`; clients must echo it | `step_messages_are_relayed...` |
| V3 | versioned protocol change | typo `levarage` | `leverage` | - |
| V4 | versioned protocol change | `PLACED_ORDERS.orderHistory` came from log files (today/yesterday, 500) | last `order_log_cap` lifecycle events for that session | - |
| Q1 | unresolved question | a self/same-address best order blocks the taker's whole submission; `keypair.address` is client supplied, so an attacker can rest an order carrying a victim's address at the best price and block that victim's takers | kept for compatibility (P3); needs a decision (skip own orders, or authenticate the address) | - |
| Q2 | unresolved question | futures trade uses the **buyer's** leverage and collateral and ignores the seller's | preserved | `futures_trade_carries_buyer_leverage_and_collateral` |
| Q3 | unresolved question | 6-decimal precision cannot express 1e-8 units; one book per unordered pair regardless of network | kept; widen the scale or add a network key before production | - |
| Q4 | unresolved question | spot `price` semantics (`amountForSale = amount * price`) is taken as-is | preserved | parity |

## Lean 4

`lean/` (Lean 4.34.1, core only, no Mathlib, no `sorry`/`axiom`). Each definition models a Rust item:

| Lean | models | what it abstracts |
|---|---|---|
| `Lifecycle.lean` `allowed`, `terminal`, `transition` | `lifecycle::edge_allowed`, `is_terminal`, `Order::transition` | event log omitted |
| `Swap.lean` `accept`, `run`, `terminate` | `SwapState::on_message` | payload size, txid shape, trade-id equality only add refusals and are omitted |
| `Match.lean` `eligible`, `bestFrom`, `pickBest`, `findMatch`, `build`, `splitDust` | `Orderbook::find_match` (specification: the linear scan with `min_by_key`; the Rust code selects through a price-level index, tested equal in `tests/index_differential.rs`), `build_trade` amounts, `split_dust` | `Nat` for raw 1e-6 units; futures use the spot-shaped `desired/sale` ids |
| `Book.lean` `place`, `cancel`, `unlock`, `sideCount`, `Bounded` | `Orderbook::submit` placement branch, `cancel`, `abort` on the maker | the pending-trade table |

Theorems (36 `#print axioms` in `AxiomCheck.lean`; only `propext`, `Classical.choice`, `Quot.sound`):

- Lifecycle: `terminal_no_exit`, `settled_only_from_locked`, `never_reenter_new`, `cancelled_only_from_live`, `transition_sound`, `transition_complete`, `unlock_edge`.
- Swap: `step5_needs_step4`, `step6_needs_step5`, `accept_succ`, `wrong_side_refused`, `run_consecutive`, `settle_needs_all_six`, `terminate_actor_is_sender`.
- Matching: `pick_sound`, `pick_best` (price priority: nothing eligible is strictly better), `pick_first` (time priority: every earlier eligible order is strictly worse), `pick_none`, `fill_price_within_limit`, `no_self_match`, `find_match_sound`.
- Conservation: `conserve_taker`, `conserve_maker` (fill + live + dust = original), `one_live_side`, `fill_le`, `fill_pos`, `no_dust_at_unit_minimum`.
- Book: `place_preserves_bound`, `place_refused_when_full`, `cancel_authorized`, `cancel_only_removes`, `cancel_preserves_bound`, `unlock_keeps_orders`, `unlock_never_removes`, `unlock_preserves_bound`, `unlock_only_clears_lock`.

Concrete vectors are repeated as `example ... := by decide`/`rfl` in Lean and asserted in Rust: the parity cases
`price_priority_buy/sell`, `time_priority_tie`, `locked_skipped`, `same_session_errors`, `same_address_errors`,
`taker_partial_then_rests`, the dust vectors of `d2_*`, the cancel vectors of `d1_*`, and the swap-step vectors of
`swap.rs`.

## Performance

`Orderbook` keeps resting orders in a `BTreeMap` keyed by an insertion sequence number (iteration = legacy array
order; a partial fill keeps its number, a remainder gets a new one) plus, for the unlocked orders, a price-level
index per (action, market leg). `submit` finds the best candidate as the first or last price level and its smallest
sequence number, `complete`/`abort`/`cancel` find orders by id and pending swaps by trade id in `O(log n)`, and side
depth and per-session load are counters. Behaviour is unchanged: `orders()` now returns an iterator over the same
sequence (`order_count()` / `is_empty()` added), and `find_match` returns the chosen `OrderId` instead of a vector
index. `tests/index_differential.rs` drives the old linear scan (kept there as a reference) against the index on
random books with locks, price ties, both spot orientations and futures, and through random submit / complete /
abort / cancel sequences.

Measured with `examples/throughput.rs` on workloads from `scripts/gen-workload.cjs` (seed 20261030; `cross` = a
crossing mix, `deep` = a deep book, every swap settles at once and the taker remainder is resubmitted). Hardware:
WSL2, 20 vCPU, kernel 6.18.54.1-microsoft-standard-WSL2, release build, single run per cell on a shared desktop
(expect noise of tens of percent). Latency is per submitted order including its fills.

| workload, orders | before orders/s | before p50 / p99 µs | before RSS MB | after orders/s | after p50 / p99 µs | after RSS MB |
|---|---|---|---|---|---|---|
| cross, 20k | 35,224 | 9.8 / 234.3 | 11.4 | 126,064 | 2.3 / 66.4 | 12.6 |
| deep, 20k | 1,458 | 125.8 / 12,792 | 12.5 | 123,845 | 1.1 / 78.4 | 15.8 |
| cross, 100k | 1,589 | 146.0 / 11,531 | 44.1 | 165,177 | 2.1 / 36.6 | 48.2 |
| deep, 100k | 329 | 893.2 / 42,587 | 52.3 | 80,417 | 1.2 / 135.2 | 68.3 |

The Rust traces (trades plus final book) are byte-identical before and after (sha256 prefixes `f6e7f4c0c2b7912d`,
`65c868532f368110`, `0de9c11bb6e4b366`, `d8b0c7a966ed56b4`). Memory grows modestly (up to +30% on the deep book)
because of the tree and index nodes.

Legacy comparison (`cross`, 20k orders, Node v18.19.1, `scripts/bench-legacy.cjs`): legacy 411 orders/s, p50 697.4
µs, p99 24,467 µs, peak RSS 109 MB; Rust in the same run 108,306 orders/s, p50 2.4 µs, p99 76.3 µs; traces IDENTICAL
(sha256 `f6e7f4c0c2b7912d`, 19,937 lines). The legacy numbers were measured with its socket, swap channel and
persistence I/O stubbed, so they are an upper bound for the real service.

Reproduce (from WSL, `tools/ob-bench.sh <cross|deep> <n> 20261030 [skip-legacy]`): it builds the example, generates
the workload, runs Rust and, unless `skip-legacy`, the legacy matcher, and compares the two traces.

## Commands

```
# from rust/tl-orderbook (WSL: tools/rust.sh and tools/lean.sh wrap these)
cargo test --locked --offline   # incl. tests/index_differential.rs
cargo clippy --locked --offline --all-targets -- -D warnings
cargo fmt --all -- --check
node scripts/compare-legacy.cjs --check     # re-runs the compiled legacy matcher; --write regenerates fixtures
cd lean && lake build && lake env lean AxiomCheck.lean
```

Parity: `scripts/compare-legacy.cjs` loads `orderbook.class.js` and the real `mix.pure.js` with only the socket
service, swap channel, order manager and `moment` stubbed (no `npm install`), runs 319 fixture books (19 hand
written, 300 pseudo-random; spot and futures, partial fills, ties, locked orders, self/address matches, batch
mode) with every swap settling, and writes the trace to `tests/fixtures/parity_expected.txt`. `tests/parity.rs`
produces the same trace from Rust and compares byte for byte. Scope: safe domain only, no dust, no limits.

CI: `.github/workflows/rust-tl-orderbook.yml` (rust job incl. the legacy `--check`, lean job). It has not run:
nothing was pushed.

## Not ported / remaining gaps

- Transport: socket.io/fastify/TLS and the Let's Encrypt paths, CORS, HTTP routes (`routes/*.ts`: `logs`, `markets`),
  `markets/*` static market list, env config. A transport adapter must authenticate the connection and map socket
  ids to `SessionId`.
- Log files (`saveLog`/`updateOrderLog`, `logs/ORDER-*`, `TRADE-*`) and their reload at start-up: replaced by the
  in-memory lifecycle log and history; durable persistence and crash/restart replay are not implemented.
- Settlement finality: a `BUYER:STEP6` txid is checked for shape only; confirming it on chain is not done here.
- Network-keyed books (`rust-refac`), STPF self-trade policies and order edit/replace are not ported.
- Lean models matching and bounds abstractly; it does not prove the Rust code itself (parity tests and shared
  vectors tie them), and the 1e-6 rounding/JS-double relation is argued above, not proved.
- No fuzzing yet.
