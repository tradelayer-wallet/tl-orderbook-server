//! Randomized differential test: the price-level index behind
//! `Orderbook::find_match` against the original linear-scan selection.
//!
//! `reference_find_match` is the pre-index implementation, kept verbatim in
//! spirit: filter every resting order through the `crosses` closure, take the
//! first minimum by price (buy taker) or first maximum (sell taker) in book
//! order, then apply the SameAccount / SameAddress checks to that single
//! candidate. Random books with locked orders, price ties, both spot leg
//! orientations and futures contracts are generated from a seeded LCG, and
//! random submit / complete / abort / cancel sequences are driven through the
//! real book; after every step the chosen order id (or error) must agree, and
//! the book order, side depth and session load must match a shadow model.

use std::cmp::Reverse;
use tl_orderbook::*;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// The original linear scan over the resting orders.
fn reference_find_match(orders: &[Order], taker: &Order) -> Result<Option<OrderId>, Error> {
    let t_price = taker.props.price();
    let crosses = |o: &Order| -> bool {
        let ids = match (&o.props, &taker.props) {
            (Props::Spot(a), Props::Spot(b)) => {
                a.id_desired == b.id_for_sale && a.id_for_sale == b.id_desired
            }
            (Props::Futures(a), Props::Futures(b)) => a.contract_id == b.contract_id,
            _ => false,
        };
        let price_ok = match taker.action {
            Action::Buy => o.props.price() <= t_price,
            Action::Sell => o.props.price() >= t_price,
        };
        ids && o.action == taker.action.opposite() && price_ok && !o.is_locked()
    };
    let candidates = orders.iter().filter(|o| crosses(o));
    let best = match taker.action {
        Action::Buy => candidates.min_by_key(|o| o.props.price()),
        Action::Sell => candidates.min_by_key(|o| Reverse(o.props.price())),
    };
    match best {
        None => Ok(None),
        Some(m) => {
            if m.session == taker.session {
                return Err(Error::SameAccount);
            }
            if m.keypair.address == taker.keypair.address {
                return Err(Error::SameAddress);
            }
            Ok(Some(m.id))
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Market {
    Spot,
    Futures,
}

const PRICES: [&str; 5] = ["1", "2", "2.5", "3", "4"];

fn random_order(rng: &mut Lcg, market: Market, id: u64, state: OrderState) -> Order {
    let session = 1 + rng.below(6);
    let action = if rng.below(2) == 0 {
        Action::Buy
    } else {
        Action::Sell
    };
    let amount = Amount::parse(&format!("{}", 1 + rng.below(9))).unwrap();
    let price = Price::parse(PRICES[rng.below(PRICES.len() as u64) as usize]).unwrap();
    let props = match market {
        Market::Spot => {
            let (d, s) = if rng.below(2) == 0 { (1, 2) } else { (2, 1) };
            Props::Spot(SpotProps {
                id_desired: d,
                id_for_sale: s,
                amount,
                price,
            })
        }
        Market::Futures => Props::Futures(FuturesProps {
            contract_id: 7,
            amount,
            price,
            leverage: Amount::parse("2").unwrap(),
            collateral: 1,
        }),
    };
    Order {
        id: OrderId(id),
        session: SessionId(session),
        keypair: Keypair {
            // addresses collide across some sessions to exercise SameAddress
            address: format!("addr{}", session % 4),
            pubkey: format!("pk{session}"),
        },
        action,
        market_name: "m".into(),
        timestamp: 0,
        props,
        state,
    }
}

fn key_of(market: Market) -> MarketKey {
    match market {
        Market::Spot => MarketKey::Spot {
            id_desired: 1,
            id_for_sale: 2,
        },
        Market::Futures => MarketKey::Futures { contract_id: 7 },
    }
}

fn limits() -> Limits {
    Limits {
        min_amount: Amount::from_raw(1).unwrap(),
        max_side_depth: 1_000_000,
        ..Limits::default()
    }
}

fn check_agree(book: &Orderbook, rng: &mut Lcg, market: Market, probes: usize, next_id: &mut u64) {
    let resting: Vec<Order> = book.orders().cloned().collect();
    for _ in 0..probes {
        let taker = random_order(rng, market, *next_id, OrderState::New);
        *next_id += 1;
        assert_eq!(
            book.find_match(&taker),
            reference_find_match(&resting, &taker),
            "taker {taker:?} against {resting:?}"
        );
    }
    // a taker of the other kind, or on other legs, never crosses
    let other = match market {
        Market::Spot => Market::Futures,
        Market::Futures => Market::Spot,
    };
    let alien = random_order(rng, other, *next_id, OrderState::New);
    *next_id += 1;
    assert_eq!(book.find_match(&alien), Ok(None));
    assert_eq!(reference_find_match(&resting, &alien), Ok(None));
}

#[test]
fn random_books_with_locks_ties_and_futures_agree_with_the_linear_scan() {
    for market in [Market::Spot, Market::Futures] {
        let mut rng = Lcg(0x5eed_0001 + market as u64);
        let mut next_id = 1_000_000;
        for round in 0..300 {
            let n = rng.below(40) as usize;
            let orders: Vec<Order> = (0..n)
                .map(|i| {
                    let state = if rng.below(4) == 0 {
                        OrderState::LockedInSwap
                    } else {
                        OrderState::Open
                    };
                    random_order(&mut rng, market, i as u64 + 1, state)
                })
                .collect();
            let book = Orderbook::with_orders(key_of(market), limits(), orders.clone())
                .expect("fixture book");
            let ids: Vec<OrderId> = book.orders().map(|o| o.id).collect();
            assert_eq!(ids, orders.iter().map(|o| o.id).collect::<Vec<_>>());
            check_agree(&book, &mut rng, market, 25, &mut next_id);
            if round % 50 == 0 {
                assert!(n == 0 || !book.is_empty());
            }
        }
    }
}

/// Mirror of the book order and loads, updated only from call results.
struct Shadow {
    ids: Vec<OrderId>,
    pending: Vec<(TradeId, SessionId)>,
}

fn check_shadow(book: &Orderbook, shadow: &Shadow) {
    let ids: Vec<OrderId> = book.orders().map(|o| o.id).collect();
    assert_eq!(ids, shadow.ids, "book order");
    assert_eq!(book.order_count(), shadow.ids.len());
    for action in [Action::Buy, Action::Sell] {
        let n = book.orders().filter(|o| o.action == action).count();
        assert_eq!(book.side_depth(action), n, "side depth");
    }
    for s in 1..=7 {
        let session = SessionId(s);
        let resting = book.orders().filter(|o| o.session == session).count();
        let flying = shadow.pending.iter().filter(|p| p.1 == session).count();
        assert_eq!(book.session_load(session), resting + flying, "load {s}");
    }
    assert_eq!(book.pending_count(), shadow.pending.len());
    for (t, _) in &shadow.pending {
        assert!(book.has_trade(*t));
    }
}

#[test]
fn random_walks_agree_with_the_linear_scan() {
    for market in [Market::Spot, Market::Futures] {
        for seed in 1..=4u64 {
            walk(market, seed);
        }
    }
}

fn walk(market: Market, seed: u64) {
    let mut rng = Lcg(0xd1ff_0000 + seed * 977 + market as u64);
    let mut book = Orderbook::new(key_of(market), limits());
    let mut shadow = Shadow {
        ids: Vec::new(),
        pending: Vec::new(),
    };
    let mut next_id = 1u64;
    let mut trade_ids = 1u64;
    for _ in 0..1500 {
        check_agree(&book, &mut rng, market, 3, &mut next_id);
        match rng.below(10) {
            0..=4 => {
                let o = random_order(&mut rng, market, next_id, OrderState::New);
                next_id += 1;
                let no_trades = rng.below(8) == 0;
                step_submit(&mut book, &mut shadow, o, &mut trade_ids, no_trades);
            }
            5..=7 => {
                if shadow.pending.is_empty() {
                    continue;
                }
                let i = rng.below(shadow.pending.len() as u64) as usize;
                let (tid, _) = shadow.pending.remove(i);
                if rng.below(5) == 0 {
                    // aborted: maker unlocks (keeps its place), taker cancelled
                    book.abort(tid, Reason::SwapTerminated, 2).expect("abort");
                } else {
                    let maker_before: Vec<Order> = book.orders().cloned().collect();
                    let done = book.complete(tid, "tx".into(), 2).expect("complete");
                    // maker removed iff the fill consumed it (dust floor is 1 raw unit)
                    let mut gone = None;
                    for m in maker_before.iter().filter(|o| o.is_locked()) {
                        let still = book.orders().find(|o| o.id == m.id);
                        if still.is_none() {
                            gone = Some(m.id);
                        }
                    }
                    if let Some(g) = gone {
                        shadow.ids.retain(|i| *i != g);
                    }
                    if let Some(rem) = done.resubmit {
                        step_submit(&mut book, &mut shadow, rem, &mut trade_ids, false);
                    }
                }
            }
            _ => {
                let unlocked: Vec<Order> =
                    book.orders().filter(|o| !o.is_locked()).cloned().collect();
                if unlocked.is_empty() {
                    continue;
                }
                let o = &unlocked[rng.below(unlocked.len() as u64) as usize];
                // a stranger is refused, the owner succeeds
                let stranger = SessionId(o.session.0 + 100);
                assert_eq!(
                    book.cancel(o.id, stranger, Reason::OwnerCancelled, 3),
                    Err(Error::NotAuthorized(o.id))
                );
                book.cancel(o.id, o.session, Reason::OwnerCancelled, 3)
                    .expect("cancel");
                shadow.ids.retain(|i| *i != o.id);
            }
        }
        book.take_events();
        check_shadow(&book, &shadow);
    }
    // drain everything: all pending settle, loads return to the resting counts
    while let Some((tid, _)) = shadow.pending.pop() {
        let before: Vec<Order> = book.orders().cloned().collect();
        let done = book.complete(tid, "tx".into(), 4).expect("complete");
        for m in before.iter().filter(|o| o.is_locked()) {
            if book.orders().all(|o| o.id != m.id) {
                shadow.ids.retain(|i| *i != m.id);
            }
        }
        if let Some(rem) = done.resubmit {
            step_submit(&mut book, &mut shadow, rem, &mut trade_ids, false);
        }
    }
    check_shadow(&book, &shadow);
}

/// Like `submit`, resolving the taker session from the order itself.
fn step_submit(
    book: &mut Orderbook,
    shadow: &mut Shadow,
    order: Order,
    trade_ids: &mut u64,
    no_trades: bool,
) {
    let session = order.session;
    let resting: Vec<Order> = book.orders().cloned().collect();
    let expected = reference_find_match(&resting, &order);
    let id = order.id;
    let tid = TradeId(*trade_ids);
    let res = book.submit(order, no_trades, tid, 1);
    match (&res, &expected) {
        (Err(e), Err(x)) => assert_eq!(e, x),
        (Ok(SubmitOutcome::Placed(_)), Ok(None)) => shadow.ids.push(id),
        (Ok(SubmitOutcome::Skipped), Ok(Some(_))) => {}
        (Ok(SubmitOutcome::Matched(req)), Ok(Some(maker))) if !no_trades => {
            let m = resting.iter().find(|o| o.id == *maker).unwrap();
            assert_eq!(req.info.maker, m.session, "swap maker = reference choice");
            assert_eq!(req.info.taker, session);
            shadow.pending.push((tid, session));
            *trade_ids += 1;
        }
        (r, x) => panic!("outcome {r:?} disagrees with reference {x:?}"),
    }
}

#[test]
fn partial_fill_keeps_the_makers_place_and_a_remainder_goes_last() {
    let mut rng = Lcg(42);
    let mut book = Orderbook::new(key_of(Market::Spot), limits());
    let mk = |rng: &mut Lcg, id, action, session: u64, d, s, amount: &str, price: &str| {
        let mut o = random_order(rng, Market::Spot, id, OrderState::New);
        o.action = action;
        o.session = SessionId(session);
        o.keypair.address = format!("a{session}");
        o.props = Props::Spot(SpotProps {
            id_desired: d,
            id_for_sale: s,
            amount: Amount::parse(amount).unwrap(),
            price: Price::parse(price).unwrap(),
        });
        o
    };
    // two sells at the same price: the earlier one is first even after it is
    // partially filled; a buy larger than it leaves a remainder that rests last.
    for (id, sess) in [(1, 10), (2, 11)] {
        let o = mk(&mut rng, id, Action::Sell, sess, 2, 1, "5", "2");
        book.submit(o, false, TradeId(id), 0).unwrap();
    }
    let buy = mk(&mut rng, 3, Action::Buy, 12, 1, 2, "3", "2");
    let SubmitOutcome::Matched(req) = book.submit(buy, false, TradeId(9), 0).unwrap() else {
        panic!("expected a match");
    };
    book.complete(req.trade_id, "tx".into(), 0).unwrap();
    let ids: Vec<u64> = book.orders().map(|o| o.id.0).collect();
    assert_eq!(ids, vec![1, 2]);
    let buy2 = mk(&mut rng, 4, Action::Buy, 13, 1, 2, "4", "2");
    let SubmitOutcome::Matched(req) = book.submit(buy2, false, TradeId(10), 0).unwrap() else {
        panic!("expected a match");
    };
    // order 1 (2 left, still the earliest at the tied price) is the maker again
    assert_eq!(req.info.maker, SessionId(10));
    let done = book.complete(req.trade_id, "tx".into(), 0).unwrap();
    let rem = done.resubmit.expect("2 left over");
    let SubmitOutcome::Matched(req) = book.submit(rem, false, TradeId(11), 0).unwrap() else {
        panic!("expected a match against order 2");
    };
    assert_eq!(req.info.maker, SessionId(11));
}
