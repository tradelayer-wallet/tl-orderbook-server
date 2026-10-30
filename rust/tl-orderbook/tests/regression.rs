//! Regression tests for the repaired legacy defects (see the README difference table, D1-D8).

mod common;
use common::*;
use tl_orderbook::*;

// ---------------------------------------------------------------------------
// D1: a swap TERMINATE removed the maker's order if the event *claimed* to come
// from the maker (legacy orderbook.class.ts addOrder error branch, using the
// payload `socketId` from channel-swap.class.ts). Now: the actor is the
// authenticated session, and an unsettled swap only unlocks the order.
// ---------------------------------------------------------------------------

#[test]
fn d1_taker_terminate_claiming_to_be_maker_does_not_delete_the_order() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    // The legacy payload carried a socketId; whatever the taker writes in the
    // payload, the actor is the taker's session.
    let claim = format!("socketId={}", maker.0);
    send(&mut srv, taker, swap_msg(t, SwapKind::Terminate, &claim), 3);
    let m = order_in(&srv, 1).expect("maker order must survive");
    assert_eq!(m.state, OrderState::Open, "unlocked, not deleted");
    assert_eq!(m.session, maker);
}

#[test]
fn d1_maker_terminate_unlocks_and_never_cancels() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    send(
        &mut srv,
        maker,
        swap_msg(t, SwapKind::Terminate, "changed my mind"),
        3,
    );
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::Open);
    // no Cancelled edge was recorded for the maker order
    assert!(!srv
        .order_log()
        .iter()
        .any(|e| e.order == OrderId(1) && e.to == OrderState::Cancelled));
    // the taker order is the one that ended, and its owner was told why
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.order == OrderId(2) && e.to == OrderState::Cancelled));
}

#[test]
fn d1_only_the_owner_can_close_and_not_while_locked() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2", "1"), 1);
    // another session tries to close it
    let out = send(&mut srv, taker, ClientEvent::CloseOrder(OrderId(1)), 2);
    assert_eq!(
        errors_for(&out, taker),
        vec![Error::NotAuthorized(OrderId(1)).to_string()]
    );
    assert!(order_in(&srv, 1).is_some());
    // owner closes while it is locked in a swap: refused
    let _t = new_channel_trade(&place(&mut srv, taker, buy(2, "2", "1"), 3)).unwrap();
    let out = send(&mut srv, maker, ClientEvent::CloseOrder(OrderId(1)), 4);
    assert_eq!(
        errors_for(&out, maker),
        vec![Error::OrderLocked(OrderId(1)).to_string()]
    );
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::LockedInSwap);
}

#[test]
fn d1_book_abort_keeps_the_maker_order_in_place() {
    let limits = Limits::default();
    let mut book = Orderbook::new(
        MarketKey::Spot {
            id_desired: 1,
            id_for_sale: 2,
        },
        limits,
    );
    let mk = |id: u64, s: u64, a: Action| {
        let raw = if a == Action::Sell {
            sell(s, "2", "1")
        } else {
            buy(s, "2", "1")
        };
        Order {
            id: OrderId(id),
            session: SessionId(s),
            keypair: raw.keypair,
            action: raw.action,
            market_name: raw.market_name,
            timestamp: 0,
            props: raw.props,
            state: OrderState::New,
        }
    };
    book.submit(mk(1, 1, Action::Sell), false, TradeId(1), 0)
        .unwrap();
    book.submit(mk(2, 2, Action::Buy), false, TradeId(1), 0)
        .unwrap();
    let before = book.order_count();
    let a = book.abort(TradeId(1), Reason::SwapTerminated, 1).unwrap();
    assert_eq!(book.order_count(), before);
    assert_eq!(a.taker.state, OrderState::Cancelled);
    assert_eq!(book.orders().next().unwrap().state, OrderState::Open);
}

// ---------------------------------------------------------------------------
// D2: dust orders. Legacy accepted any positive amount, so a one-satoshi order
// at the best price was matched first by everyone, each fill costing a full
// on-chain swap. Now: minimum size, and dust remainders are dropped.
// ---------------------------------------------------------------------------

#[test]
fn d2_dust_and_zero_orders_are_rejected() {
    let mut srv = server();
    let a = conn(&mut srv);
    let out = place(&mut srv, a, sell(1, "2", "0.000999"), 1);
    assert_eq!(errors_for(&out, a), vec![Error::BelowMinimum.to_string()]);
    let out = place(&mut srv, a, sell(1, "2", "0"), 1);
    assert_eq!(errors_for(&out, a), vec![Error::ZeroAmount.to_string()]);
    assert!(
        srv.books().books().is_empty(),
        "no empty book is left behind"
    );
    // exactly the minimum is fine
    let out = place(&mut srv, a, sell(1, "2", "0.001"), 1);
    assert!(errors_for(&out, a).is_empty());
}

#[test]
fn d2_dust_remainder_is_dropped_and_accounted() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2", "1.0005"), 1);
    let out = place(&mut srv, taker, buy(2, "2", "1"), 2);
    let t = new_channel_trade(&out).unwrap();
    // the request tells the wallets there is nothing left to continue with
    assert!(out.iter().all(|o| match &o.event {
        ServerEvent::NewChannel { unfilled, .. } => unfilled.is_none(),
        _ => true,
    }));
    run_all_steps(&mut srv, t, taker, maker, 3);
    assert!(
        order_in(&srv, 1).is_none(),
        "0.0005 remainder is not left on the book"
    );
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.order == OrderId(1) && e.reason == Reason::FilledDust));
}

#[test]
fn d2_remainder_exactly_at_minimum_stays() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2", "1.001"), 1);
    let t = new_channel_trade(&place(&mut srv, taker, buy(2, "2", "1"), 2)).unwrap();
    run_all_steps(&mut srv, t, taker, maker, 3);
    assert_eq!(
        order_in(&srv, 1).unwrap().props.amount(),
        Amount::parse("0.001").unwrap()
    );
}

#[test]
fn d2_conservation_with_dust() {
    // fill + live remainders + dust == originals, at the build_trade level.
    let min = Limits::default().min_amount;
    let mk = |action, amount: &str| Order {
        id: OrderId(1),
        session: SessionId(1),
        keypair: kp(1),
        action,
        market_name: "m".into(),
        timestamp: 0,
        props: match action {
            Action::Buy => buy(1, "2", amount).props,
            Action::Sell => sell(2, "2", amount).props,
        },
        state: OrderState::Open,
    };
    for (t, m) in [
        ("1", "1.0005"),
        ("1.0005", "1"),
        ("1", "1"),
        ("0.5", "7"),
        ("7", "0.002"),
    ] {
        let taker = mk(Action::Buy, t);
        let maker = mk(Action::Sell, m);
        let b = build_trade(&taker, &maker, min).unwrap();
        let ta = taker.props.amount().raw();
        let ma = maker.props.amount().raw();
        assert_eq!(b.fill.raw() + b.taker_live.raw() + b.taker_dust.raw(), ta);
        assert_eq!(b.fill.raw() + b.maker_live.raw() + b.maker_dust.raw(), ma);
        assert!(b.taker_live.is_zero() || b.maker_live.is_zero());
    }
}

// ---------------------------------------------------------------------------
// D3: unbounded work per connection.
// ---------------------------------------------------------------------------

#[test]
fn d3_orders_per_session_are_capped() {
    let mut srv = Server::new(Limits {
        max_orders_per_session: 3,
        ..Limits::default()
    });
    let (a, b) = (conn(&mut srv), conn(&mut srv));
    for i in 0..3 {
        let out = place(&mut srv, a, sell(1, &format!("{}", 5 + i), "1"), 1);
        assert!(errors_for(&out, a).is_empty());
    }
    let out = place(&mut srv, a, sell(1, "9", "1"), 1);
    assert_eq!(
        errors_for(&out, a),
        vec![Error::SessionOrderLimit.to_string()]
    );
    // another session is unaffected, and closing frees a slot
    assert!(errors_for(&place(&mut srv, b, sell(2, "9", "1"), 1), b).is_empty());
    send(&mut srv, a, ClientEvent::CloseOrder(OrderId(1)), 2);
    assert!(errors_for(&place(&mut srv, a, sell(1, "9", "1"), 3), a).is_empty());
}

#[test]
fn d3_batch_orders_count_against_the_session_cap() {
    let mut srv = Server::new(Limits {
        max_orders_per_session: 3,
        ..Limits::default()
    });
    let a = conn(&mut srv);
    let batch: Vec<_> = (0..10)
        .map(|i| sell(1, &format!("{}", 5 + i), "1"))
        .collect();
    send(&mut srv, a, ClientEvent::ManyOrders(batch), 1);
    assert_eq!(srv.books().orders_by_session(a).len(), 3);
}

#[test]
fn d3_batch_size_is_capped() {
    let mut srv = Server::new(Limits {
        max_batch: 4,
        ..Limits::default()
    });
    let a = conn(&mut srv);
    let batch: Vec<_> = (0..5)
        .map(|i| sell(1, &format!("{}", 5 + i), "1"))
        .collect();
    let out = send(&mut srv, a, ClientEvent::ManyOrders(batch), 1);
    assert_eq!(errors_for(&out, a), vec![Error::BatchTooLarge.to_string()]);
    assert!(srv.books().books().is_empty());
}

#[test]
fn d3_book_depth_is_capped_per_side() {
    let mut srv = Server::new(Limits {
        max_side_depth: 2,
        max_orders_per_session: 100,
        ..Limits::default()
    });
    let (a, b, c) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    place(&mut srv, a, sell(1, "9", "1"), 1);
    place(&mut srv, b, sell(2, "9", "1"), 1);
    let out = place(&mut srv, c, sell(3, "9", "1"), 1);
    assert_eq!(errors_for(&out, c), vec![Error::BookFull.to_string()]);
    // the buy side has its own budget
    assert!(errors_for(&place(&mut srv, c, buy(3, "1", "1"), 1), c).is_empty());
    assert_eq!(srv.books().books()[0].side_depth(Action::Sell), 2);
}

#[test]
fn d3_books_sessions_and_swaps_are_capped() {
    let mut srv = Server::new(Limits {
        max_books: 1,
        max_sessions: 2,
        ..Limits::default()
    });
    let a = conn(&mut srv);
    let _b = conn(&mut srv);
    assert_eq!(srv.connect("x", 0), Err(Error::TooManySessions));
    place(&mut srv, a, sell(1, "9", "1"), 1);
    let out = place(&mut srv, a, future(Action::Sell, 1, "9", "1", "2"), 1);
    assert_eq!(errors_for(&out, a), vec![Error::TooManyBooks.to_string()]);
    assert_eq!(srv.books().books().len(), 1);
}

#[test]
fn d3_swaps_per_session_are_capped_and_the_match_is_undone() {
    let mut srv = Server::new(Limits {
        max_swaps_per_session: 1,
        ..Limits::default()
    });
    let (maker, t1, t2) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2", "1"), 1);
    place(&mut srv, maker, sell(1, "3", "1"), 1);
    let first = place(&mut srv, t1, buy(2, "2", "1"), 2);
    assert!(new_channel_trade(&first).is_some());
    let second = place(&mut srv, t2, buy(3, "3", "1"), 3);
    assert_eq!(
        errors_for(&second, t2),
        vec![Error::SessionSwapLimit.to_string()]
    );
    assert_eq!(srv.pending_swaps(), 1);
    assert_eq!(
        order_in(&srv, 2).unwrap().state,
        OrderState::Open,
        "second maker order is released"
    );
}

#[test]
fn d3_total_pending_swaps_are_capped() {
    let mut srv = Server::new(Limits {
        max_pending_swaps: 1,
        ..Limits::default()
    });
    let (m1, m2, t1, t2) = (
        conn(&mut srv),
        conn(&mut srv),
        conn(&mut srv),
        conn(&mut srv),
    );
    place(&mut srv, m1, sell(1, "2", "1"), 1);
    place(&mut srv, m2, sell(2, "3", "1"), 1);
    assert!(new_channel_trade(&place(&mut srv, t1, buy(3, "2", "1"), 2)).is_some());
    let out = place(&mut srv, t2, buy(4, "3", "1"), 2);
    assert_eq!(errors_for(&out, t2), vec![Error::TooManySwaps.to_string()]);
}

#[test]
fn d3_history_and_order_log_are_capped() {
    let mut srv = Server::new(Limits {
        history_cap: 2,
        order_log_cap: 5,
        ..Limits::default()
    });
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    for i in 0..3u64 {
        place(&mut srv, maker, sell(1, "2", "1"), i);
        let t = new_channel_trade(&place(&mut srv, taker, buy(2, "2", "1"), i)).unwrap();
        run_all_steps(&mut srv, t, taker, maker, 10 + i);
    }
    let book = &srv.books().books()[0];
    assert_eq!(book.history().len(), 2);
    assert_eq!(book.history()[0].time, 12, "newest first");
    assert_eq!(srv.order_log().len(), 5);
}

// ---------------------------------------------------------------------------
// D4: swap steps were not bound to each other, to the trade, or to the sender.
// ---------------------------------------------------------------------------

#[test]
fn d4_step5_without_step4_is_refused_and_the_swap_survives() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    send(&mut srv, maker, swap_msg(t, SwapKind::Step(1), "a"), 3);
    send(&mut srv, taker, swap_msg(t, SwapKind::Step(2), "b"), 3);
    send(&mut srv, maker, swap_msg(t, SwapKind::Step(3), "c"), 3);
    let out = send(&mut srv, maker, swap_msg(t, SwapKind::Step(5), "d"), 3);
    assert_eq!(
        errors_for(&out, maker),
        vec![Error::StepOutOfOrder {
            expected: 4,
            got: 5
        }
        .to_string()]
    );
    assert!(
        out.iter()
            .all(|o| !matches!(&o.event, ServerEvent::Swap { .. })),
        "nothing relayed"
    );
    assert_eq!(srv.swap_state(t).unwrap().last_step, 3);
    // the proper continuation still works
    let out = send(&mut srv, taker, swap_msg(t, SwapKind::Step(4), "e"), 4);
    assert_eq!(out.len(), 1);
}

#[test]
fn d4_step6_cannot_settle_a_trade_that_never_ran() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    let out = send(&mut srv, taker, swap_msg(t, SwapKind::Step(6), TXID), 3);
    assert_eq!(
        errors_for(&out, taker),
        vec![Error::StepOutOfOrder {
            expected: 1,
            got: 6
        }
        .to_string()]
    );
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::LockedInSwap);
    assert!(srv.books().books()[0].history().is_empty());
}

#[test]
fn d4_wrong_side_outsider_and_foreign_trade_are_refused() {
    let mut srv = server();
    let (m1, t1, m2, t2, spy) = (
        conn(&mut srv),
        conn(&mut srv),
        conn(&mut srv),
        conn(&mut srv),
        conn(&mut srv),
    );
    // two independent trades in different markets
    place(&mut srv, m1, sell(1, "2", "1"), 1);
    let ta = new_channel_trade(&place(&mut srv, t1, buy(2, "2", "1"), 1)).unwrap();
    place(&mut srv, m2, future(Action::Sell, 3, "9", "1", "2"), 1);
    let tb = new_channel_trade(&place(
        &mut srv,
        t2,
        future(Action::Buy, 4, "9", "1", "2"),
        1,
    ))
    .unwrap();
    assert_ne!(ta, tb);

    // buyer sending the seller's step
    let out = send(&mut srv, t1, swap_msg(ta, SwapKind::Step(1), "x"), 2);
    assert_eq!(errors_for(&out, t1), vec![Error::WrongRole.to_string()]);
    // a bystander cannot terminate or inject
    let out = send(&mut srv, spy, swap_msg(ta, SwapKind::Terminate, "boom"), 2);
    assert_eq!(
        errors_for(&out, spy),
        vec![Error::NotParticipant.to_string()]
    );
    // a participant of trade A cannot drive trade B
    let out = send(&mut srv, m1, swap_msg(tb, SwapKind::Step(1), "x"), 2);
    assert_eq!(
        errors_for(&out, m1),
        vec![Error::NotParticipant.to_string()]
    );
    assert_eq!(srv.pending_swaps(), 2);
    assert_eq!(srv.swap_state(ta).unwrap().last_step, 0);
    assert_eq!(srv.swap_state(tb).unwrap().last_step, 0);
}

#[test]
fn d4_bad_txid_oversized_payload_and_replay_are_refused() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    for n in 1..=5u8 {
        let from = if n % 2 == 1 { maker } else { taker };
        send(&mut srv, from, swap_msg(t, SwapKind::Step(n), "x"), 3);
    }
    let out = send(
        &mut srv,
        taker,
        swap_msg(t, SwapKind::Step(6), "deadbeef"),
        3,
    );
    assert_eq!(errors_for(&out, taker), vec![Error::BadTxid.to_string()]);
    let big = "a".repeat(srv.books().limits().max_swap_payload + 1);
    let out = send(&mut srv, taker, swap_msg(t, SwapKind::Step(6), &big), 3);
    assert_eq!(
        errors_for(&out, taker),
        vec![Error::PayloadTooLarge.to_string()]
    );
    send(&mut srv, taker, swap_msg(t, SwapKind::Step(6), TXID), 3);
    assert_eq!(srv.pending_swaps(), 0);
    // replaying the settlement is refused: the trade is gone
    let out = send(&mut srv, taker, swap_msg(t, SwapKind::Step(6), TXID), 4);
    assert_eq!(
        errors_for(&out, taker),
        vec![Error::UnknownTrade(t).to_string()]
    );
    assert_eq!(srv.books().books()[0].history().len(), 1);
}

#[test]
fn d4_unknown_event_names_are_refused() {
    assert_eq!(SwapKind::from_wire("BUYER:STEP7"), Err(Error::BadSwapEvent));
    assert_eq!(
        SwapKind::from_wire("SELLER:STEP2"),
        Err(Error::BadSwapEvent)
    );
}

// ---------------------------------------------------------------------------
// D5-D8: validation, swap timeout, cancel-while-locked, error propagation.
// ---------------------------------------------------------------------------

#[test]
fn d5_validation_rejects_malformed_orders() {
    let mut srv = server();
    let a = conn(&mut srv);
    let cases: Vec<(RawOrder, Error)> = vec![
        (
            {
                let mut o = sell(1, "2", "1");
                o.keypair.address = String::new();
                o
            },
            Error::BadKeypair("address length"),
        ),
        (
            {
                let mut o = sell(1, "2", "1");
                o.keypair.address = "a b".into();
                o
            },
            Error::BadKeypair("address characters"),
        ),
        (
            {
                let mut o = sell(1, "2", "1");
                o.keypair.pubkey = "zz".into();
                o
            },
            Error::BadKeypair("pubkey must be 33 or 65 bytes of hex"),
        ),
        (
            {
                let mut o = sell(1, "2", "1");
                o.market_name = "x".repeat(65);
                o
            },
            Error::BadMarketName,
        ),
        (sell(1, "0", "1"), Error::ZeroPrice),
        (sell(1, "1000000000", "1000000000"), Error::NotionalOverflow),
        (future(Action::Sell, 1, "2", "1", "0"), Error::BadLeverage),
        (
            future(Action::Sell, 1, "2", "1", "1001"),
            Error::BadLeverage,
        ),
        (
            RawOrder {
                props: Props::Spot(SpotProps {
                    id_desired: 3,
                    id_for_sale: 3,
                    amount: Amount::parse("1").unwrap(),
                    price: Price::parse("1").unwrap(),
                }),
                ..sell(1, "2", "1")
            },
            Error::SameAssetPair,
        ),
    ];
    for (raw, want) in cases {
        let out = place(&mut srv, a, raw, 1);
        assert_eq!(errors_for(&out, a), vec![want.to_string()]);
    }
    assert!(srv.books().books().is_empty());
}

#[test]
fn preserved_matching_errors_keep_their_legacy_text() {
    assert_eq!(
        Error::SameAccount.to_string(),
        "Match of the order from the same Account"
    );
    assert_eq!(
        Error::SameAddress.to_string(),
        "Match of the order from the same address"
    );
    assert_eq!(
        Error::Mismatch.to_string(),
        "Order missmatch current orderbook interface or type"
    );
}

#[test]
fn sanity_failed_first_order_leaves_no_empty_book() {
    let mut srv = server();
    let a = conn(&mut srv);
    let out = place(&mut srv, a, sell(1, "2", "0.0001"), 1);
    assert_eq!(errors_for(&out, a).len(), 1);
    assert!(srv.books().books().is_empty());
}

#[test]
fn d8_failed_remainder_is_cancelled_not_leaked() {
    // The taker's remainder re-enters the book and now finds only its own
    // session's order at the best price: it is cancelled and reported.
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2", "1"), 1);
    let t = new_channel_trade(&place(&mut srv, taker, buy(2, "3", "2"), 2)).unwrap();
    // taker also rests a sell at a price that the remainder would cross
    place(&mut srv, taker, sell(2, "2.5", "1"), 3);
    let out = run_all_steps(&mut srv, t, taker, maker, 4);
    assert_eq!(
        errors_for(&out, taker),
        vec![Error::SameAccount.to_string()]
    );
    assert!(order_in(&srv, 2).is_none());
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.order == OrderId(2) && e.to == OrderState::Cancelled));
}

#[test]
fn d6_a_stalled_swap_cannot_lock_a_maker_order_forever() {
    // Legacy: the channel promise only resolved on BUYER:STEP6 / TERMINATE_TRADE,
    // so a taker that went silent kept the maker's order locked until it disconnected.
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let _t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::LockedInSwap);
    let timeout = srv.books().limits().swap_timeout_ms;
    srv.tick(2 + timeout);
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::Open);
    assert_eq!(srv.pending_swaps(), 0);
    // and the maker can be matched again
    let again = place(&mut srv, taker, buy(12, "2", "1"), 3 + timeout);
    assert!(new_channel_trade(&again).is_some());
}

#[test]
fn d7_a_locked_order_cannot_be_cancelled_mid_swap() {
    // Legacy removeOrder had no lock check: the owner could delete the order
    // during the swap and the later removal silently failed.
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    let out = send(&mut srv, maker, ClientEvent::CloseOrder(OrderId(1)), 3);
    assert_eq!(
        errors_for(&out, maker),
        vec![Error::OrderLocked(OrderId(1)).to_string()]
    );
    run_all_steps(&mut srv, t, taker, maker, 4);
    assert_eq!(
        srv.books().books()[0].history().len(),
        1,
        "swap still settled"
    );
}
