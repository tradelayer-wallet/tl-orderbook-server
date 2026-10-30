//! End-to-end behaviour of the socket protocol, matching, swap relay and
//! lifecycle through `Server`.

mod common;
use common::*;
use tl_orderbook::*;

#[test]
fn resting_order_is_saved_and_listed() {
    let mut srv = server();
    let a = conn(&mut srv);
    let out = place(&mut srv, a, sell(1, "2.5", "1.5"), 10);
    let evs = to_session(&out, a);
    assert!(evs.contains(&&ServerEvent::OrderSaved(Some(OrderId(1)))));
    assert!(evs.contains(&&ServerEvent::UpdateOrdersRequest));
    let placed = evs
        .iter()
        .find_map(|e| match e {
            ServerEvent::PlacedOrders { open_orders, .. } => Some(open_orders.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(placed.len(), 1);
    assert_eq!(placed[0].state, OrderState::Open);
    assert_eq!(placed[0].timestamp, 10);
}

#[test]
fn full_swap_settles_both_orders_and_records_history() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, maker, sell(1, "2.5", "1.5"), 1);
    let out = place(&mut srv, taker, buy(2, "2.5", "1.5"), 2);

    // both wallets are told to open the channel, with the right roles
    let chans: Vec<_> = out
        .iter()
        .filter_map(|o| match (&o.dest, &o.event) {
            (
                Dest::Session(s),
                ServerEvent::NewChannel {
                    trade_id,
                    info,
                    unfilled,
                    is_buyer,
                },
            ) => Some((*s, *trade_id, info.clone(), unfilled.clone(), *is_buyer)),
            _ => None,
        })
        .collect();
    assert_eq!(chans.len(), 2);
    let (s0, t, info, unfilled, b0) = chans[0].clone();
    assert_eq!(s0, taker);
    assert!(b0, "taker is the buyer");
    assert!(unfilled.is_none());
    assert!(!chans[1].4);
    assert_eq!(info.buyer.session, taker);
    assert_eq!(info.seller.session, maker);
    assert_eq!(info.taker, taker);
    assert_eq!(info.maker, maker);
    assert_eq!(
        info.props,
        TradeProps::Spot {
            prop_id_desired: 1,
            prop_id_for_sale: 2,
            amount_desired: Amount::parse("1.5").unwrap(),
            amount_for_sale: Amount::parse("3.75").unwrap(),
        }
    );

    // maker order is locked while the swap runs
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::LockedInSwap);

    run_all_steps(&mut srv, t, taker, maker, 5);

    assert!(
        order_in(&srv, 1).is_none(),
        "filled maker order leaves the book"
    );
    assert_eq!(srv.pending_swaps(), 0);
    let book = &srv.books().books()[0];
    assert_eq!(book.history().len(), 1);
    assert_eq!(book.history()[0].txid, TXID);
    assert_eq!(book.history()[0].time, 5);

    // lifecycle log: maker Open -> Locked -> Settled, taker New -> Locked -> Settled
    let log: Vec<_> = srv
        .order_log()
        .iter()
        .map(|e| (e.order.0, e.from, e.to))
        .collect();
    use OrderState::*;
    assert_eq!(
        log,
        vec![
            (1, New, Open),
            (1, Open, LockedInSwap),
            (2, New, LockedInSwap),
            (1, LockedInSwap, Settled),
            (2, LockedInSwap, Settled),
        ]
    );
}

#[test]
fn step_messages_are_relayed_to_the_counterparty_only() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    let out = send(
        &mut srv,
        maker,
        swap_msg(t, SwapKind::Step(1), "multisig"),
        3,
    );
    assert_eq!(
        out,
        vec![Outbound {
            dest: Dest::Session(taker),
            event: ServerEvent::Swap {
                trade_id: t,
                from: maker,
                kind: SwapKind::Step(1),
                payload: "multisig".into()
            }
        }]
    );
}

#[test]
fn taker_partial_fill_rests_remainder_and_can_match_again() {
    let mut srv = server();
    let (m1, m2, taker) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    place(&mut srv, m1, sell(1, "2.0", "1"), 1);
    place(&mut srv, m2, sell(2, "2.2", "1"), 1);
    let out = place(&mut srv, taker, buy(3, "2.5", "1.5"), 2);
    let t1 = new_channel_trade(&out).unwrap();
    // the remainder (0.5) immediately crosses m2's order and opens a second swap
    let out = run_all_steps(&mut srv, t1, taker, m1, 3);
    let t2 = new_channel_trade(&out).expect("remainder re-enters and matches");
    assert_ne!(t1, t2);
    let st = srv.swap_state(t2).unwrap();
    assert_eq!(st.seller, m2);
    run_all_steps(&mut srv, t2, taker, m2, 4);
    let remaining = order_in(&srv, 2).unwrap();
    assert_eq!(remaining.props.amount(), Amount::parse("0.5").unwrap());
    assert_eq!(remaining.state, OrderState::Open);
    assert!(order_in(&srv, 1).is_none());
    assert!(order_in(&srv, 3).is_none(), "taker fully filled");
}

#[test]
fn maker_partial_fill_keeps_its_place_in_the_queue() {
    let mut srv = server();
    let (a, b, taker) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    place(&mut srv, a, sell(1, "2.0", "3"), 1);
    place(&mut srv, b, sell(2, "2.0", "1"), 1);
    let out = place(&mut srv, taker, buy(3, "2.0", "1"), 2);
    let t = new_channel_trade(&out).unwrap();
    run_all_steps(&mut srv, t, taker, a, 3);
    let ids: Vec<u64> = srv.books().books()[0]
        .orders()
        .iter()
        .map(|o| o.id.0)
        .collect();
    assert_eq!(ids, vec![1, 2], "partially filled maker stays first");
    assert_eq!(
        order_in(&srv, 1).unwrap().props.amount(),
        Amount::parse("2").unwrap()
    );
}

#[test]
fn futures_trade_carries_buyer_leverage_and_collateral() {
    let mut srv = server();
    let (m, t) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, m, future(Action::Sell, 1, "100", "2", "5"), 1);
    let out = place(&mut srv, t, future(Action::Buy, 2, "101", "2", "3"), 2);
    let info = out
        .iter()
        .find_map(|o| match &o.event {
            ServerEvent::NewChannel { info, .. } => Some(info.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        info.props,
        TradeProps::Futures {
            amount: Amount::parse("2").unwrap(),
            contract_id: 5,
            price: Price::parse("100").unwrap(),
            leverage: Amount::parse("3").unwrap(),
            collateral: 1,
        }
    );
}

#[test]
fn update_orderbook_hides_locked_orders_and_returns_history() {
    let mut srv = server();
    let (m, t, viewer) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    place(&mut srv, m, sell(1, "2", "1"), 1);
    place(&mut srv, m, sell(1, "3", "1"), 1);
    let tr = new_channel_trade(&place(&mut srv, t, buy(2, "2", "1"), 2)).unwrap();
    let filter = Filter::Spot {
        first_token: 2,
        second_token: 1,
    }; // reversed pair still finds the book
    let out = send(&mut srv, viewer, ClientEvent::UpdateOrderbook(filter), 3);
    match &out[0].event {
        ServerEvent::OrderbookData { orders, history } => {
            assert_eq!(orders.len(), 1, "locked order hidden");
            assert!(history.is_empty());
        }
        e => panic!("{e:?}"),
    }
    run_all_steps(&mut srv, tr, t, m, 4);
    let out = send(&mut srv, viewer, ClientEvent::UpdateOrderbook(filter), 5);
    match &out[0].event {
        ServerEvent::OrderbookData { orders, history } => {
            assert_eq!(orders.len(), 1);
            assert_eq!(history.len(), 1);
        }
        e => panic!("{e:?}"),
    }
    // unknown market -> empty data
    let out = send(
        &mut srv,
        viewer,
        ClientEvent::UpdateOrderbook(Filter::Futures { contract_id: 99 }),
        5,
    );
    assert_eq!(
        out[0].event,
        ServerEvent::OrderbookData {
            orders: vec![],
            history: vec![]
        }
    );
}

#[test]
fn market_orders_are_rejected() {
    let mut srv = server();
    let a = conn(&mut srv);
    let mut raw = sell(1, "2", "1");
    raw.is_limit_order = false;
    let out = place(&mut srv, a, raw, 1);
    assert_eq!(
        errors_for(&out, a),
        vec!["Market orders not allowed".to_string()]
    );
    assert!(srv.books().books().is_empty());
}

#[test]
fn many_orders_places_resting_and_silently_skips_crossing() {
    let mut srv = server();
    let (a, b) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, a, sell(1, "2", "1"), 1);
    let batch = vec![buy(2, "1.5", "1"), buy(2, "2.5", "1"), buy(2, "1.4", "1")];
    let out = send(&mut srv, b, ClientEvent::ManyOrders(batch), 2);
    assert!(out.iter().any(|o| o.event == ServerEvent::OrderSaved(None)));
    assert_eq!(srv.pending_swaps(), 0, "batch never opens a swap");
    let mine = srv.books().orders_by_session(b);
    assert_eq!(mine.len(), 2, "crossing 2.5 buy was dropped");
    // the dropped order is logged as cancelled
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.reason == Reason::BatchCrossing && e.to == OrderState::Cancelled));
}

#[test]
fn close_order_by_owner_cancels_and_notifies_all() {
    let mut srv = server();
    let a = conn(&mut srv);
    place(&mut srv, a, sell(1, "2", "1"), 1);
    let out = send(&mut srv, a, ClientEvent::CloseOrder(OrderId(1)), 2);
    assert!(out
        .iter()
        .any(|o| o.dest == Dest::All && o.event == ServerEvent::UpdateOrdersRequest));
    assert!(order_in(&srv, 1).is_none());
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.reason == Reason::OwnerCancelled && e.to == OrderState::Cancelled));
}

#[test]
fn disconnect_cancels_open_orders() {
    let mut srv = server();
    let a = conn(&mut srv);
    place(&mut srv, a, sell(1, "2", "1"), 1);
    place(&mut srv, a, sell(1, "3", "1"), 1);
    srv.disconnect(a, 5);
    assert!(srv.books().books()[0].orders().is_empty());
    assert!(!srv.sessions().contains(a));
    assert_eq!(
        srv.handle(a, ClientEvent::CloseOrder(OrderId(1)), 6),
        Err(Error::UnknownSession)
    );
}

#[test]
fn disconnect_mid_swap_unlocks_the_counterparty_order() {
    let mut srv = server();
    let (maker, taker, other) = (conn(&mut srv), conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    let _ = other;
    srv.drain();
    srv.disconnect(taker, 9);
    let out = srv.drain();
    // maker is told the swap ended and gets its order back
    assert!(out.iter().any(|o| o.dest == Dest::Session(maker)
        && matches!(&o.event, ServerEvent::Swap { kind: SwapKind::Terminate, trade_id, .. } if *trade_id == t)));
    let m = order_in(&srv, 1).unwrap();
    assert_eq!(m.state, OrderState::Open);
    assert_eq!(srv.pending_swaps(), 0);
    assert_eq!(srv.books().pending_swaps(), 0);
}

#[test]
fn disconnect_of_maker_mid_swap_cancels_its_orders_after_unlock() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let _t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    srv.disconnect(maker, 9);
    assert!(order_in(&srv, 1).is_none());
    // taker's order was the swap's taker; it ends Cancelled
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.order == OrderId(2) && e.to == OrderState::Cancelled));
}

#[test]
fn timeout_unlocks_makers_and_tells_both_sides() {
    let mut srv = server();
    let (maker, taker) = (conn(&mut srv), conn(&mut srv));
    let t = open_trade(&mut srv, maker, taker, "2", "1", "1");
    srv.drain();
    let timeout = srv.books().limits().swap_timeout_ms;
    srv.tick(2 + timeout - 1);
    assert_eq!(srv.pending_swaps(), 1, "not yet expired");
    srv.tick(2 + timeout);
    assert_eq!(srv.pending_swaps(), 0);
    let out = srv.drain();
    assert!(errors_for(&out, taker).contains(&"swap timed out".to_string()));
    assert_eq!(order_in(&srv, 1).unwrap().state, OrderState::Open);
    assert!(srv
        .order_log()
        .iter()
        .any(|e| e.reason == Reason::SwapTimedOut));
    // a late message for the dead trade is refused
    let out = send(
        &mut srv,
        maker,
        swap_msg(t, SwapKind::Step(1), "x"),
        2 + timeout + 1,
    );
    assert_eq!(
        errors_for(&out, maker),
        vec![Error::UnknownTrade(t).to_string()]
    );
}

#[test]
fn outbox_is_bounded() {
    let mut srv = Server::new(Limits {
        outbox_cap: 3,
        ..Limits::default()
    });
    let a = conn(&mut srv);
    for i in 0..5 {
        place(&mut srv, a, sell(1, "2", "1"), i);
        // not drained between calls on purpose
        let _ = i;
    }
    // each call drains via helper, so queue stays small; fill without draining:
    for _ in 0..5 {
        srv.handle(
            a,
            ClientEvent::UpdateOrderbook(Filter::Futures { contract_id: 1 }),
            9,
        )
        .unwrap();
    }
    assert_eq!(srv.drain().len(), 3);
    assert!(srv.dropped_events() >= 2);
}

#[test]
fn client_event_wire_names() {
    assert_eq!(
        ClientEvent::CloseOrder(OrderId(1)).wire_name(),
        "close-order"
    );
    assert_eq!(ClientEvent::ManyOrders(vec![]).wire_name(), "many-orders");
    assert_eq!(
        ClientEvent::UpdateOrderbook(Filter::Futures { contract_id: 1 }).wire_name(),
        "update-orderbook"
    );
    assert_eq!(
        ServerEvent::OrderError(String::new()).wire_name(),
        "order:error"
    );
    assert_eq!(ServerEvent::OrderSaved(None).wire_name(), "order:saved");
    assert_eq!(
        ServerEvent::UpdateOrdersRequest.wire_name(),
        "update-orders-request"
    );
}

#[test]
fn unknown_session_cannot_act() {
    let mut srv = server();
    assert_eq!(
        srv.handle(SessionId(77), ClientEvent::CloseOrder(OrderId(1)), 0),
        Err(Error::UnknownSession)
    );
}

#[test]
fn same_session_best_match_blocks_the_taker_like_legacy() {
    // Preserved legacy contract: the best price belongs to the taker's own session,
    // so the whole submission fails (the next-best order is not tried).
    let mut srv = server();
    let (a, b) = (conn(&mut srv), conn(&mut srv));
    place(&mut srv, a, sell(1, "2.0", "1"), 1);
    place(&mut srv, b, sell(2, "2.5", "1"), 1);
    let out = place(&mut srv, a, buy(3, "3.0", "1"), 2);
    assert_eq!(
        errors_for(&out, a),
        vec!["Match of the order from the same Account".to_string()]
    );
    assert_eq!(srv.pending_swaps(), 0);
}
