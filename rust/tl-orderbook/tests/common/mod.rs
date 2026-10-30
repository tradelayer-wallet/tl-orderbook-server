#![allow(dead_code)]
//! Shared helpers for the integration tests. Synthetic keys and addresses only.

use tl_orderbook::*;

pub const TXID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub fn kp(n: u64) -> Keypair {
    Keypair {
        address: format!("tltest{n}"),
        pubkey: format!("02{:064x}", n),
    }
}

/// Spot order in the canonical asset pair 1/2: a BUY wants asset 1 for asset 2.
pub fn spot(action: Action, key: u64, price: &str, amount: &str) -> RawOrder {
    let (desired, sale) = match action {
        Action::Buy => (1, 2),
        Action::Sell => (2, 1),
    };
    RawOrder {
        keypair: kp(key),
        action,
        is_limit_order: true,
        market_name: "TL/LTC".into(),
        props: Props::Spot(SpotProps {
            id_desired: desired,
            id_for_sale: sale,
            amount: Amount::parse(amount).unwrap(),
            price: Price::parse(price).unwrap(),
        }),
    }
}

pub fn buy(key: u64, price: &str, amount: &str) -> RawOrder {
    spot(Action::Buy, key, price, amount)
}
pub fn sell(key: u64, price: &str, amount: &str) -> RawOrder {
    spot(Action::Sell, key, price, amount)
}

pub fn future(action: Action, key: u64, price: &str, amount: &str, lev: &str) -> RawOrder {
    RawOrder {
        keypair: kp(key),
        action,
        is_limit_order: true,
        market_name: "TL/LTC".into(),
        props: Props::Futures(FuturesProps {
            contract_id: 5,
            amount: Amount::parse(amount).unwrap(),
            price: Price::parse(price).unwrap(),
            leverage: Amount::parse(lev).unwrap(),
            collateral: 1,
        }),
    }
}

pub fn server() -> Server {
    Server::new(Limits::default())
}

pub fn conn(srv: &mut Server) -> SessionId {
    srv.connect("203.0.113.9", 0).unwrap()
}

pub fn send(srv: &mut Server, s: SessionId, ev: ClientEvent, now: u64) -> Vec<Outbound> {
    srv.handle(s, ev, now).unwrap();
    srv.drain()
}

pub fn place(srv: &mut Server, s: SessionId, raw: RawOrder, now: u64) -> Vec<Outbound> {
    send(srv, s, ClientEvent::NewOrder(raw), now)
}

pub fn swap_msg(trade: TradeId, kind: SwapKind, payload: &str) -> ClientEvent {
    ClientEvent::Swap(SwapMsg {
        trade_id: trade,
        kind,
        payload: payload.to_string(),
    })
}

/// Events delivered to one session (including broadcasts).
pub fn to_session(out: &[Outbound], s: SessionId) -> Vec<&ServerEvent> {
    out.iter()
        .filter(|o| o.dest == Dest::Session(s) || o.dest == Dest::All)
        .map(|o| &o.event)
        .collect()
}

pub fn errors_for(out: &[Outbound], s: SessionId) -> Vec<String> {
    out.iter()
        .filter(|o| o.dest == Dest::Session(s))
        .filter_map(|o| match &o.event {
            ServerEvent::OrderError(e) => Some(e.clone()),
            _ => None,
        })
        .collect()
}

pub fn new_channel_trade(out: &[Outbound]) -> Option<TradeId> {
    out.iter().find_map(|o| match &o.event {
        ServerEvent::NewChannel { trade_id, .. } => Some(*trade_id),
        _ => None,
    })
}

/// Place a sell by `maker` and a crossing buy by `taker`; return the trade id.
pub fn open_trade(
    srv: &mut Server,
    maker: SessionId,
    taker: SessionId,
    price: &str,
    maker_amt: &str,
    taker_amt: &str,
) -> TradeId {
    place(srv, maker, sell(10 + maker.0, price, maker_amt), 1);
    let out = place(srv, taker, buy(10 + taker.0, price, taker_amt), 2);
    new_channel_trade(&out).expect("crossing buy opens a swap")
}

/// Run the six protocol steps; the buyer is `buyer`, the seller `seller`.
/// Returns the events produced by the final step (settlement).
pub fn run_all_steps(
    srv: &mut Server,
    t: TradeId,
    buyer: SessionId,
    seller: SessionId,
    now: u64,
) -> Vec<Outbound> {
    for n in 1..=5u8 {
        let from = if n % 2 == 1 { seller } else { buyer };
        send(srv, from, swap_msg(t, SwapKind::Step(n), "psbt"), now);
    }
    send(srv, buyer, swap_msg(t, SwapKind::Step(6), TXID), now)
}

pub fn order_in(srv: &Server, id: u64) -> Option<Order> {
    srv.books()
        .books()
        .iter()
        .flat_map(|b| b.orders())
        .find(|o| o.id == OrderId(id))
        .cloned()
}
