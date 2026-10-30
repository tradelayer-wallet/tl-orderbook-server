//! The socket event protocol and an in-memory session manager.
//!
//! Ports `src/services/socket/{events,manager.class}.ts`. The transport
//! (socket.io over fastify) is not ported: a transport adapter authenticates
//! the connection, calls [`Server::connect`], feeds decoded [`ClientEvent`]s
//! to [`Server::handle`] with the connection's [`SessionId`], and delivers
//! whatever [`Server::drain`] returns. The session id always comes from the
//! transport, never from message contents.
//!
//! Wire names (legacy `OnEvents` / `EmitEvents` / `OrderEmitEvents`):
//!
//! | event | direction | wire name |
//! |---|---|---|
//! | [`ClientEvent::NewOrder`] | in | `new-order` |
//! | [`ClientEvent::ManyOrders`] | in | `many-orders` |
//! | [`ClientEvent::UpdateOrderbook`] | in | `update-orderbook` |
//! | [`ClientEvent::CloseOrder`] | in | `close-order` |
//! | [`ClientEvent::Swap`] | in | `${socketId}::swap` (legacy), `swap` |
//! | [`ServerEvent::OrderbookData`] | out | `orderbook-data` |
//! | [`ServerEvent::PlacedOrders`] | out | `placed-orders` |
//! | [`ServerEvent::UpdateOrdersRequest`] | out (all) | `update-orders-request` |
//! | [`ServerEvent::OrderError`] | out | `order:error` |
//! | [`ServerEvent::OrderSaved`] | out | `order:saved` |
//! | [`ServerEvent::NewChannel`] | out | `new-channel` |
//! | [`ServerEvent::Swap`] | out | relayed `swap` |

use std::collections::{BTreeMap, VecDeque};

use crate::book::{HistoryTrade, SubmitOutcome, SwapRequest, TradeInfo};
use crate::error::Error;
use crate::lifecycle::{LifecycleEvent, Reason};
use crate::manager::OrderbookManager;
use crate::swap::{SwapAction, SwapKind, SwapMsg, SwapState};
use crate::types::{Filter, Order, OrderId, OrderState, RawOrder, SessionId, TradeId};
use crate::validate::{validate, Limits};

/// Legacy `OnEvents.CONNECTION`.
pub const EV_CONNECTION: &str = "connection";
/// Legacy `OnEvents.DISCONNECT`.
pub const EV_DISCONNECT: &str = "disconnect";

/// Events a client may send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientEvent {
    NewOrder(RawOrder),
    ManyOrders(Vec<RawOrder>),
    UpdateOrderbook(Filter),
    CloseOrder(OrderId),
    Swap(SwapMsg),
}

impl ClientEvent {
    pub fn wire_name(&self) -> &'static str {
        match self {
            ClientEvent::NewOrder(_) => "new-order",
            ClientEvent::ManyOrders(_) => "many-orders",
            ClientEvent::UpdateOrderbook(_) => "update-orderbook",
            ClientEvent::CloseOrder(_) => "close-order",
            ClientEvent::Swap(_) => "swap",
        }
    }
}

/// Events the server sends. (Short-lived values moved straight into an
/// outbox, so the size spread between variants is not worth a `Box`.)
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerEvent {
    OrderError(String),
    OrderSaved(Option<OrderId>),
    PlacedOrders {
        open_orders: Vec<Order>,
        order_history: Vec<LifecycleEvent>,
    },
    OrderbookData {
        orders: Vec<Order>,
        history: Vec<HistoryTrade>,
    },
    UpdateOrdersRequest,
    NewChannel {
        trade_id: TradeId,
        info: TradeInfo,
        unfilled: Option<Order>,
        is_buyer: bool,
    },
    /// A swap message relayed from the counterparty.
    Swap {
        trade_id: TradeId,
        from: SessionId,
        kind: SwapKind,
        payload: String,
    },
}

impl ServerEvent {
    pub fn wire_name(&self) -> &'static str {
        match self {
            ServerEvent::OrderError(_) => "order:error",
            ServerEvent::OrderSaved(_) => "order:saved",
            ServerEvent::PlacedOrders { .. } => "placed-orders",
            ServerEvent::OrderbookData { .. } => "orderbook-data",
            ServerEvent::UpdateOrdersRequest => "update-orders-request",
            ServerEvent::NewChannel { .. } => "new-channel",
            ServerEvent::Swap { .. } => "swap",
        }
    }
}

/// Where an outbound event goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dest {
    Session(SessionId),
    /// Every connected session (`io.emit`).
    All,
}

/// One queued outbound event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    pub dest: Dest,
    pub event: ServerEvent,
}

/// `IClientSession`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: SessionId,
    pub start_time: u64,
    pub ip: String,
}

/// Live sessions (legacy `SocketManager.liveSessions`).
#[derive(Debug)]
pub struct SessionManager {
    sessions: BTreeMap<SessionId, SessionInfo>,
    next: u64,
    max: usize,
}

impl SessionManager {
    pub fn new(max: usize) -> SessionManager {
        SessionManager {
            sessions: BTreeMap::new(),
            next: 1,
            max,
        }
    }
    pub fn connect(&mut self, ip: &str, now: u64) -> Result<SessionId, Error> {
        if self.sessions.len() >= self.max {
            return Err(Error::TooManySessions);
        }
        let id = SessionId(self.next);
        self.next = self.next.saturating_add(1);
        let ip: String = ip.chars().take(64).collect();
        self.sessions.insert(
            id,
            SessionInfo {
                id,
                start_time: now,
                ip,
            },
        );
        Ok(id)
    }
    pub fn disconnect(&mut self, id: SessionId) -> bool {
        self.sessions.remove(&id).is_some()
    }
    pub fn contains(&self, id: SessionId) -> bool {
        self.sessions.contains_key(&id)
    }
    pub fn len(&self) -> usize {
        self.sessions.len()
    }
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
    pub fn live_sessions(&self) -> impl Iterator<Item = &SessionInfo> {
        self.sessions.values()
    }
}

/// The whole external orderbook service, minus the transport.
#[derive(Debug)]
pub struct Server {
    limits: Limits,
    sessions: SessionManager,
    books: OrderbookManager,
    swaps: BTreeMap<TradeId, SwapState>,
    outbox: VecDeque<Outbound>,
    dropped: u64,
    next_order: u64,
    order_log: VecDeque<LifecycleEvent>,
}

impl Server {
    pub fn new(limits: Limits) -> Server {
        Server {
            sessions: SessionManager::new(limits.max_sessions),
            books: OrderbookManager::new(limits.clone()),
            swaps: BTreeMap::new(),
            outbox: VecDeque::new(),
            dropped: 0,
            next_order: 1,
            order_log: VecDeque::new(),
            limits,
        }
    }

    pub fn sessions(&self) -> &SessionManager {
        &self.sessions
    }
    pub fn books(&self) -> &OrderbookManager {
        &self.books
    }
    /// Recent lifecycle events (bounded by `Limits::order_log_cap`).
    pub fn order_log(&self) -> &VecDeque<LifecycleEvent> {
        &self.order_log
    }
    pub fn swap_state(&self, trade: TradeId) -> Option<&SwapState> {
        self.swaps.get(&trade)
    }
    pub fn pending_swaps(&self) -> usize {
        self.swaps.len()
    }
    /// Outbound events discarded because the outbox was full.
    pub fn dropped_events(&self) -> u64 {
        self.dropped
    }

    /// Take everything queued for delivery.
    pub fn drain(&mut self) -> Vec<Outbound> {
        self.outbox.drain(..).collect()
    }

    fn push(&mut self, dest: Dest, event: ServerEvent) {
        if event == ServerEvent::UpdateOrdersRequest {
            if let Some(last) = self.outbox.back() {
                if last.event == ServerEvent::UpdateOrdersRequest && last.dest == dest {
                    return;
                }
            }
        }
        if self.outbox.len() >= self.limits.outbox_cap {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.outbox.push_back(Outbound { dest, event });
    }

    fn error_to(&mut self, s: SessionId, e: &Error) {
        self.push(Dest::Session(s), ServerEvent::OrderError(e.to_string()));
    }

    fn collect_events(&mut self) {
        for e in self.books.take_events() {
            if self.order_log.len() >= self.limits.order_log_cap {
                self.order_log.pop_front();
            }
            self.order_log.push_back(e);
        }
    }

    fn placed_orders_event(&self, s: SessionId) -> ServerEvent {
        ServerEvent::PlacedOrders {
            open_orders: self.books.orders_by_session(s),
            order_history: self
                .order_log
                .iter()
                .filter(|e| e.session == s)
                .cloned()
                .collect(),
        }
    }

    fn send_placed_orders(&mut self, s: SessionId) {
        if self.sessions.contains(s) {
            let ev = self.placed_orders_event(s);
            self.push(Dest::Session(s), ev);
        }
    }

    /// A transport accepted a connection.
    pub fn connect(&mut self, ip: &str, now: u64) -> Result<SessionId, Error> {
        self.sessions.connect(ip, now)
    }

    /// Dispatch one client event. Protocol-level refusals are reported to
    /// the sender as `order:error`; the `Err` return is only for an unknown
    /// session.
    pub fn handle(
        &mut self,
        session: SessionId,
        event: ClientEvent,
        now: u64,
    ) -> Result<(), Error> {
        if !self.sessions.contains(session) {
            return Err(Error::UnknownSession);
        }
        match event {
            ClientEvent::NewOrder(raw) => self.on_new_order(session, raw, now),
            ClientEvent::ManyOrders(raws) => self.on_many_orders(session, raws, now),
            ClientEvent::UpdateOrderbook(filter) => self.on_update_orderbook(session, &filter),
            ClientEvent::CloseOrder(id) => self.on_close_order(session, id, now),
            ClientEvent::Swap(msg) => self.on_swap(session, msg, now),
        }
        self.collect_events();
        Ok(())
    }

    fn build_order(
        &mut self,
        session: SessionId,
        raw: &RawOrder,
        now: u64,
    ) -> Result<Order, Error> {
        validate(raw, &self.limits)?;
        let id = OrderId(self.next_order);
        self.next_order = self.next_order.saturating_add(1);
        Ok(Order {
            id,
            session,
            keypair: raw.keypair.clone(),
            action: raw.action,
            market_name: raw.market_name.clone(),
            timestamp: now,
            props: raw.props.clone(),
            state: OrderState::New,
        })
    }

    fn on_new_order(&mut self, s: SessionId, raw: RawOrder, now: u64) {
        let order = match self.build_order(s, &raw, now) {
            Ok(o) => o,
            Err(e) => return self.error_to(s, &e),
        };
        match self.books.submit(order, false, now) {
            Err(e) => self.error_to(s, &e),
            Ok(outcome) => self.deliver(s, outcome, now),
        }
    }

    /// Common tail of a successful submit (new order or remainder).
    fn deliver(&mut self, s: SessionId, outcome: SubmitOutcome, now: u64) {
        match outcome {
            SubmitOutcome::Placed(o) => {
                self.collect_events();
                self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
                self.push(Dest::Session(s), ServerEvent::OrderSaved(Some(o.id)));
                self.send_placed_orders(s);
            }
            SubmitOutcome::Matched(req) => {
                if let Err(e) = self.start_swap(&req, now) {
                    // Over a swap limit: undo the match, the taker is told.
                    let _ = self.books.abort(req.trade_id, Reason::SwapTerminated, now);
                    self.error_to(s, &e);
                }
                self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
            }
            SubmitOutcome::Skipped => {}
        }
    }

    fn swaps_involving(&self, s: SessionId) -> usize {
        self.swaps.values().filter(|w| w.involves(s)).count()
    }

    fn start_swap(&mut self, req: &SwapRequest, now: u64) -> Result<(), Error> {
        if self.swaps.len() >= self.limits.max_pending_swaps {
            return Err(Error::TooManySwaps);
        }
        let buyer = req.info.buyer.session;
        let seller = req.info.seller.session;
        if self.swaps_involving(buyer) >= self.limits.max_swaps_per_session
            || self.swaps_involving(seller) >= self.limits.max_swaps_per_session
        {
            return Err(Error::SessionSwapLimit);
        }
        self.swaps.insert(
            req.trade_id,
            SwapState::new(req.trade_id, buyer, seller, now),
        );
        for (sess, is_buyer) in [(buyer, true), (seller, false)] {
            self.push(
                Dest::Session(sess),
                ServerEvent::NewChannel {
                    trade_id: req.trade_id,
                    info: req.info.clone(),
                    unfilled: req.unfilled.clone(),
                    is_buyer,
                },
            );
        }
        Ok(())
    }

    fn on_many_orders(&mut self, s: SessionId, raws: Vec<RawOrder>, now: u64) {
        if raws.len() > self.limits.max_batch {
            return self.error_to(s, &Error::BatchTooLarge);
        }
        let mut placed_any = false;
        for raw in &raws {
            // Legacy: per-order failures and crossing orders are skipped silently.
            if let Ok(order) = self.build_order(s, raw, now) {
                if let Ok(SubmitOutcome::Placed(_)) = self.books.submit(order, true, now) {
                    placed_any = true;
                }
            }
        }
        self.collect_events();
        if placed_any {
            self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
        }
        self.push(Dest::Session(s), ServerEvent::OrderSaved(None));
        self.send_placed_orders(s);
    }

    fn on_update_orderbook(&mut self, s: SessionId, filter: &Filter) {
        let (orders, history) = match self.books.find_by_filter(filter) {
            Some(b) => (
                b.orders().filter(|o| !o.is_locked()).cloned().collect(),
                b.history().iter().cloned().collect(),
            ),
            None => (Vec::new(), Vec::new()),
        };
        self.push(
            Dest::Session(s),
            ServerEvent::OrderbookData { orders, history },
        );
    }

    fn on_close_order(&mut self, s: SessionId, id: OrderId, now: u64) {
        match self.books.cancel(id, s, Reason::OwnerCancelled, now) {
            Ok(_) => {
                self.collect_events();
                self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
            }
            Err(e) => self.error_to(s, &e),
        }
        self.send_placed_orders(s);
    }

    fn on_swap(&mut self, from: SessionId, msg: SwapMsg, now: u64) {
        let trade_id = msg.trade_id;
        let action = match self.swaps.get_mut(&trade_id) {
            None => return self.error_to(from, &Error::UnknownTrade(trade_id)),
            Some(st) => match st.on_message(from, &msg, self.limits.max_swap_payload) {
                Ok(a) => a,
                Err(e) => return self.error_to(from, &e),
            },
        };
        let relay = |to: SessionId| {
            (
                Dest::Session(to),
                ServerEvent::Swap {
                    trade_id,
                    from,
                    kind: msg.kind,
                    payload: msg.payload.clone(),
                },
            )
        };
        match action {
            SwapAction::Relay { to } => {
                let (d, e) = relay(to);
                self.push(d, e);
            }
            SwapAction::Settle { txid } => {
                let counter = match self.swaps.remove(&trade_id) {
                    Some(st) => {
                        if from == st.buyer {
                            st.seller
                        } else {
                            st.buyer
                        }
                    }
                    None => return,
                };
                let (d, e) = relay(counter);
                self.push(d, e);
                match self.books.complete(trade_id, txid, now) {
                    Err(e) => self.error_to(from, &e),
                    Ok(c) => {
                        self.collect_events();
                        self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
                        if let Some(rem) = c.resubmit {
                            self.resubmit(rem, now);
                        }
                        self.send_placed_orders(c.trade.info.maker);
                        self.send_placed_orders(c.trade.info.taker);
                    }
                }
            }
            SwapAction::Terminated { by, reason } => {
                let counter = match self.swaps.remove(&trade_id) {
                    Some(st) => {
                        if by == st.buyer {
                            st.seller
                        } else {
                            st.buyer
                        }
                    }
                    None => return,
                };
                let (d, e) = relay(counter);
                self.push(d, e);
                self.end_unsettled(trade_id, Reason::SwapTerminated, &reason, now);
            }
        }
    }

    /// Abort a swap in the book and tell the taker why. The maker's order is
    /// unlocked and stays on the book.
    fn end_unsettled(&mut self, trade_id: TradeId, reason: Reason, text: &str, now: u64) {
        match self.books.abort(trade_id, reason, now) {
            Ok(a) => {
                self.collect_events();
                self.push(
                    Dest::Session(a.taker.session),
                    ServerEvent::OrderError(text.to_string()),
                );
                self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
                self.send_placed_orders(a.maker_session);
                self.send_placed_orders(a.taker.session);
            }
            Err(e) => self.push(Dest::All, ServerEvent::OrderError(e.to_string())),
        }
    }

    fn resubmit(&mut self, order: Order, now: u64) {
        let s = order.session;
        match self.books.submit(order, false, now) {
            Err(e) => {
                self.error_to(s, &e);
            }
            Ok(outcome) => self.deliver(s, outcome, now),
        }
    }

    /// A connection closed: end its swaps (counterparties' orders are
    /// unlocked) and cancel everything it still has open.
    pub fn disconnect(&mut self, session: SessionId, now: u64) {
        if !self.sessions.contains(session) {
            return;
        }
        let involved: Vec<(TradeId, SessionId)> = self
            .swaps
            .values()
            .filter(|w| w.involves(session))
            .map(|w| {
                (
                    w.trade_id,
                    if w.buyer == session {
                        w.seller
                    } else {
                        w.buyer
                    },
                )
            })
            .collect();
        for (trade_id, counter) in involved {
            self.swaps.remove(&trade_id);
            self.push(
                Dest::Session(counter),
                ServerEvent::Swap {
                    trade_id,
                    from: session,
                    kind: SwapKind::Terminate,
                    payload: "counterparty disconnected".to_string(),
                },
            );
            self.end_unsettled(
                trade_id,
                Reason::SwapTerminated,
                "counterparty disconnected",
                now,
            );
        }
        for o in self.books.orders_by_session(session) {
            let _ = self.books.cancel(o.id, session, Reason::Disconnected, now);
        }
        self.sessions.disconnect(session);
        self.collect_events();
        self.push(Dest::All, ServerEvent::UpdateOrdersRequest);
    }

    /// Abort swaps that outlived `Limits::swap_timeout_ms`. Deterministic:
    /// the caller supplies the clock.
    pub fn tick(&mut self, now: u64) {
        for trade_id in self.books.expired_trades(now) {
            if let Some(st) = self.swaps.remove(&trade_id) {
                for s in [st.buyer, st.seller] {
                    self.push(
                        Dest::Session(s),
                        ServerEvent::Swap {
                            trade_id,
                            from: s,
                            kind: SwapKind::Terminate,
                            payload: "swap timed out".to_string(),
                        },
                    );
                }
            }
            self.end_unsettled(trade_id, Reason::SwapTimedOut, "swap timed out", now);
        }
        self.collect_events();
    }
}
