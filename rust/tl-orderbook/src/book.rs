//! One orderbook: matching, trade construction and the swap-pending lifecycle.
//!
//! Ports `src/services/orderbook/orderbook.class.ts`:
//!
//! * `checkCompatible` / `findByFilter`   -> [`MarketKey::compatible`] / [`MarketKey::matches_filter`]
//! * `checkMatch`                         -> [`Orderbook::find_match`]
//! * `buildTrade`                         -> [`build_trade`]
//! * `addOrder` (sync part)               -> [`Orderbook::submit`]
//! * `addOrder` (after the channel result) -> [`Orderbook::complete`] / [`Orderbook::abort`]
//! * `removeOrder`                        -> [`Orderbook::cancel`]
//!
//! The legacy `addOrder` awaited the swap channel inside the same call. Here
//! the swap is asynchronous: `submit` locks the maker and returns a
//! [`SwapRequest`]; the swap relay later calls `complete` (settled) or
//! `abort` (not settled).
//!
//! # Matching rule (exactly the TS)
//!
//! For an incoming order `t`, the candidates are resting orders `o` with the
//! crossing id pair (spot: `o.desired == t.for_sale && o.for_sale ==
//! t.desired`; futures: same contract), the opposite action, an acceptable
//! price (buy taker: `o.price <= t.price`; sell taker: `o.price >=
//! t.price`) and not locked. The best candidate is the lowest price for a buy
//! taker and the highest for a sell taker; ties go to the earliest in book
//! order (JS `Array.sort` is stable). If the best candidate has the taker's
//! session or the taker's address, the whole submission fails (the legacy
//! behaviour; the next-best candidate is *not* tried). The fill is
//! `min(amounts)` at the **maker's** price.

use std::cmp::Reverse;
use std::collections::VecDeque;

use crate::amount::{notional, Amount, Price};
use crate::error::Error;
use crate::lifecycle::{LifecycleEvent, Reason};
use crate::types::{
    Action, Filter, Keypair, MarketKind, Order, OrderId, OrderState, Props, SessionId, TradeId,
};
use crate::validate::Limits;

/// Identity of a book: spot pair (either direction) or futures contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketKey {
    Spot { id_desired: u32, id_for_sale: u32 },
    Futures { contract_id: u32 },
}

impl MarketKey {
    /// Key of the book a first order would create.
    pub fn from_props(p: &Props) -> MarketKey {
        match p {
            Props::Spot(s) => MarketKey::Spot {
                id_desired: s.id_desired,
                id_for_sale: s.id_for_sale,
            },
            Props::Futures(f) => MarketKey::Futures {
                contract_id: f.contract_id,
            },
        }
    }

    pub fn kind(&self) -> MarketKind {
        match self {
            MarketKey::Spot { .. } => MarketKind::Spot,
            MarketKey::Futures { .. } => MarketKind::Futures,
        }
    }

    /// Legacy `checkCompatible`: same type and the same ids (spot in either order).
    pub fn compatible(&self, p: &Props) -> bool {
        match (self, p) {
            (
                MarketKey::Spot {
                    id_desired,
                    id_for_sale,
                },
                Props::Spot(s),
            ) => {
                (s.id_desired == *id_desired && s.id_for_sale == *id_for_sale)
                    || (s.id_desired == *id_for_sale && s.id_for_sale == *id_desired)
            }
            (MarketKey::Futures { contract_id }, Props::Futures(f)) => {
                f.contract_id == *contract_id
            }
            _ => false,
        }
    }

    /// Legacy `findByFilter`.
    pub fn matches_filter(&self, f: &Filter) -> bool {
        match (self, f) {
            (
                MarketKey::Spot {
                    id_desired,
                    id_for_sale,
                },
                Filter::Spot {
                    first_token,
                    second_token,
                },
            ) => {
                (first_token == id_desired && second_token == id_for_sale)
                    || (first_token == id_for_sale && second_token == id_desired)
            }
            (MarketKey::Futures { contract_id }, Filter::Futures { contract_id: c }) => {
                c == contract_id
            }
            _ => false,
        }
    }

    /// Legacy `orderbookName` (log file stem).
    pub fn name(&self) -> String {
        match self {
            MarketKey::Spot {
                id_desired,
                id_for_sale,
            } => format!("spot_{id_for_sale}_{id_desired}"),
            MarketKey::Futures { contract_id } => format!("futures-{contract_id}"),
        }
    }
}

/// `ITradeClinetInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TradeParty {
    pub session: SessionId,
    pub keypair: Keypair,
}

/// `IFuturesTradeProps` / `ISpotTradeProps`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TradeProps {
    Spot {
        prop_id_desired: u32,
        prop_id_for_sale: u32,
        amount_desired: Amount,
        amount_for_sale: Amount,
    },
    Futures {
        amount: Amount,
        contract_id: u32,
        price: Price,
        leverage: Amount,
        collateral: u32,
    },
}

/// `ITradeInfo`: everything the two wallets need to run the swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TradeInfo {
    pub kind: MarketKind,
    pub buyer: TradeParty,
    pub seller: TradeParty,
    pub taker: SessionId,
    pub maker: SessionId,
    pub props: TradeProps,
}

/// `IHistoryTrade`: a settled trade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTrade {
    pub info: TradeInfo,
    pub txid: String,
    pub time: u64,
}

/// The request to open a swap channel for one match (`new-channel` payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapRequest {
    pub trade_id: TradeId,
    pub info: TradeInfo,
    /// The unfilled remainder of the larger order, if any (legacy `unfilled`).
    pub unfilled: Option<Order>,
}

/// Result of [`build_trade`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltTrade {
    pub info: TradeInfo,
    pub fill: Amount,
    pub taker_live: Amount,
    pub taker_dust: Amount,
    pub maker_live: Amount,
    pub maker_dust: Amount,
    pub unfilled: Option<Order>,
}

fn split_dust(remainder: Amount, min: Amount) -> (Amount, Amount) {
    if remainder.is_zero() || remainder >= min {
        (remainder, Amount::ZERO)
    } else {
        (Amount::ZERO, remainder)
    }
}

/// Legacy `buildTrade(new_order, old_order)`.
///
/// `min` is the dust threshold; a remainder below it is not kept (set it to
/// one raw unit to reproduce the legacy behaviour exactly).
pub fn build_trade(taker: &Order, maker: &Order, min: Amount) -> Result<BuiltTrade, Error> {
    let (buy, sell) = match (taker.action, maker.action) {
        (Action::Buy, Action::Sell) => (taker, maker),
        (Action::Sell, Action::Buy) => (maker, taker),
        _ => return Err(Error::Mismatch),
    };
    let t_amt = taker.props.amount();
    let m_amt = maker.props.amount();
    let fill = t_amt.min_of(m_amt);
    let price = maker.props.price();

    let t_rem = t_amt.checked_sub(fill).unwrap_or(Amount::ZERO);
    let m_rem = m_amt.checked_sub(fill).unwrap_or(Amount::ZERO);
    let (taker_live, taker_dust) = split_dust(t_rem, min);
    let (maker_live, maker_dust) = split_dust(m_rem, min);

    let unfilled = if !taker_live.is_zero() {
        let mut o = taker.clone();
        o.props.set_amount(taker_live);
        Some(o)
    } else if !maker_live.is_zero() {
        let mut o = maker.clone();
        o.props.set_amount(maker_live);
        Some(o)
    } else {
        None
    };

    let props = match &buy.props {
        Props::Futures(f) => TradeProps::Futures {
            amount: fill,
            contract_id: f.contract_id,
            price,
            leverage: f.leverage,
            collateral: f.collateral,
        },
        Props::Spot(s) => TradeProps::Spot {
            prop_id_desired: s.id_desired,
            prop_id_for_sale: s.id_for_sale,
            amount_desired: fill,
            amount_for_sale: notional(fill, price)?,
        },
    };
    let info = TradeInfo {
        kind: taker.props.kind(),
        buyer: TradeParty {
            session: buy.session,
            keypair: buy.keypair.clone(),
        },
        seller: TradeParty {
            session: sell.session,
            keypair: sell.keypair.clone(),
        },
        taker: taker.session,
        maker: maker.session,
        props,
    };
    Ok(BuiltTrade {
        info,
        fill,
        taker_live,
        taker_dust,
        maker_live,
        maker_dust,
        unfilled,
    })
}

/// A match whose swap has not finished.
#[derive(Debug, Clone)]
struct Pending {
    trade_id: TradeId,
    taker: Order,
    maker_id: OrderId,
    built: BuiltTrade,
    created_at: u64,
}

/// What [`Orderbook::submit`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitOutcome {
    /// Rested on the book.
    Placed(Order),
    /// Crossed the book: maker locked, swap requested.
    Matched(SwapRequest),
    /// Crossed the book inside a batch (`no_trades`); order dropped (legacy).
    Skipped,
}

/// A settled swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub trade: HistoryTrade,
    /// Live remainder of the taker, to be submitted again (legacy recursion).
    pub resubmit: Option<Order>,
    pub fill: Amount,
    pub taker_dust: Amount,
    pub maker_dust: Amount,
}

/// An abandoned swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aborted {
    pub trade_id: TradeId,
    /// The taker order, now `Cancelled`.
    pub taker: Order,
    pub maker_id: OrderId,
    pub maker_session: SessionId,
}

/// One market's resting orders, history and in-flight swaps.
#[derive(Debug, Clone)]
pub struct Orderbook {
    key: MarketKey,
    limits: Limits,
    orders: Vec<Order>,
    history: VecDeque<HistoryTrade>,
    pending: Vec<Pending>,
    events: Vec<LifecycleEvent>,
}

impl Orderbook {
    pub fn new(key: MarketKey, limits: Limits) -> Orderbook {
        Orderbook {
            key,
            limits,
            orders: Vec::new(),
            history: VecDeque::new(),
            pending: Vec::new(),
            events: Vec::new(),
        }
    }

    /// Build a book around existing resting orders (legacy: assigning
    /// `orderbook.orders`). Used for restore and for parity fixtures.
    pub fn with_orders(
        key: MarketKey,
        limits: Limits,
        orders: Vec<Order>,
    ) -> Result<Orderbook, Error> {
        let mut book = Orderbook::new(key, limits);
        for o in &orders {
            if !book.key.compatible(&o.props) {
                return Err(Error::Mismatch);
            }
            if !matches!(o.state, OrderState::Open | OrderState::LockedInSwap) {
                return Err(Error::IllegalTransition);
            }
        }
        for action in [Action::Buy, Action::Sell] {
            if orders.iter().filter(|o| o.action == action).count() > book.limits.max_side_depth {
                return Err(Error::BookFull);
            }
        }
        book.orders = orders;
        Ok(book)
    }

    pub fn key(&self) -> &MarketKey {
        &self.key
    }
    pub fn name(&self) -> String {
        self.key.name()
    }
    /// Resting orders in book (insertion) order.
    pub fn orders(&self) -> &[Order] {
        &self.orders
    }
    /// Settled trades, newest first.
    pub fn history(&self) -> &VecDeque<HistoryTrade> {
        &self.history
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn side_depth(&self, action: Action) -> usize {
        self.orders.iter().filter(|o| o.action == action).count()
    }
    /// Resting orders plus in-flight takers owned by `session`.
    pub fn session_load(&self, session: SessionId) -> usize {
        self.orders.iter().filter(|o| o.session == session).count()
            + self
                .pending
                .iter()
                .filter(|p| p.taker.session == session)
                .count()
    }
    /// Take and clear the lifecycle events recorded since the last call.
    pub fn take_events(&mut self) -> Vec<LifecycleEvent> {
        std::mem::take(&mut self.events)
    }
    pub fn check_compatible(&self, order: &Order) -> bool {
        self.key.compatible(&order.props)
    }

    /// Legacy `checkMatch`: index of the best crossing resting order.
    pub fn find_match(&self, taker: &Order) -> Result<Option<usize>, Error> {
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
        let candidates = self.orders.iter().enumerate().filter(|(_, o)| crosses(o));
        // min_by_key returns the first minimum: price priority, then book
        // order (time priority), matching a stable sort followed by [0].
        let best = match taker.action {
            Action::Buy => candidates.min_by_key(|(_, o)| o.props.price()),
            Action::Sell => candidates.min_by_key(|(_, o)| Reverse(o.props.price())),
        };
        match best {
            None => Ok(None),
            Some((idx, m)) => {
                if m.session == taker.session {
                    return Err(Error::SameAccount);
                }
                if m.keypair.address == taker.keypair.address {
                    return Err(Error::SameAddress);
                }
                Ok(Some(idx))
            }
        }
    }

    /// Legacy `addOrder`, up to the point where the swap channel opens.
    ///
    /// `order` must be `New` (fresh) or `Open` (the live remainder of an
    /// order whose swap just settled). On error, a remainder (`Open`) is
    /// cancelled; a fresh order was never accepted and leaves no trace.
    pub fn submit(
        &mut self,
        mut order: Order,
        no_trades: bool,
        trade_id: TradeId,
        now: u64,
    ) -> Result<SubmitOutcome, Error> {
        let was_remainder = order.state == OrderState::Open;
        match self.submit_inner(&mut order, no_trades, trade_id, now) {
            Ok(outcome) => Ok(outcome),
            Err(e) => {
                if was_remainder && order.state == OrderState::Open {
                    // best-effort: a remainder that cannot be re-added is cancelled
                    let _ = order.transition(
                        OrderState::Cancelled,
                        Reason::SwapTerminated,
                        now,
                        &mut self.events,
                    );
                }
                Err(e)
            }
        }
    }

    fn submit_inner(
        &mut self,
        order: &mut Order,
        no_trades: bool,
        trade_id: TradeId,
        now: u64,
    ) -> Result<SubmitOutcome, Error> {
        if !matches!(order.state, OrderState::New | OrderState::Open) {
            return Err(Error::IllegalTransition);
        }
        if !self.check_compatible(order) {
            return Err(Error::Mismatch);
        }
        match self.find_match(order)? {
            None => {
                if self.side_depth(order.action) >= self.limits.max_side_depth {
                    return Err(Error::BookFull);
                }
                if order.state == OrderState::New {
                    order.transition(OrderState::Open, Reason::Placed, now, &mut self.events)?;
                }
                self.orders.push(order.clone());
                Ok(SubmitOutcome::Placed(order.clone()))
            }
            Some(idx) => {
                if no_trades {
                    if order.state == OrderState::New {
                        order.transition(
                            OrderState::Cancelled,
                            Reason::BatchCrossing,
                            now,
                            &mut self.events,
                        )?;
                    }
                    return Ok(SubmitOutcome::Skipped);
                }
                let built = build_trade(order, &self.orders[idx], self.limits.min_amount)?;
                let maker_id = self.orders[idx].id;
                self.orders[idx].transition(
                    OrderState::LockedInSwap,
                    Reason::Matched,
                    now,
                    &mut self.events,
                )?;
                order.transition(
                    OrderState::LockedInSwap,
                    Reason::Matched,
                    now,
                    &mut self.events,
                )?;
                let request = SwapRequest {
                    trade_id,
                    info: built.info.clone(),
                    unfilled: built.unfilled.clone(),
                };
                self.pending.push(Pending {
                    trade_id,
                    taker: order.clone(),
                    maker_id,
                    built,
                    created_at: now,
                });
                Ok(SubmitOutcome::Matched(request))
            }
        }
    }

    /// The swap settled with `txid`. Applies the fill to both orders.
    pub fn complete(
        &mut self,
        trade_id: TradeId,
        txid: String,
        now: u64,
    ) -> Result<Completion, Error> {
        let pos = self
            .pending
            .iter()
            .position(|p| p.trade_id == trade_id)
            .ok_or(Error::UnknownTrade(trade_id))?;
        let maker_id = self.pending[pos].maker_id;
        let midx = self
            .orders
            .iter()
            .position(|o| o.id == maker_id)
            .ok_or(Error::NotFound(maker_id))?;
        let p = self.pending.remove(pos);
        let built = p.built;

        if built.maker_live.is_zero() {
            let reason = if built.maker_dust.is_zero() {
                Reason::Filled
            } else {
                Reason::FilledDust
            };
            self.orders[midx].transition(OrderState::Settled, reason, now, &mut self.events)?;
            self.orders.remove(midx);
        } else {
            let m = &mut self.orders[midx];
            m.props.set_amount(built.maker_live);
            m.transition(OrderState::Open, Reason::PartialFill, now, &mut self.events)?;
        }

        let mut taker = p.taker;
        let resubmit = if built.taker_live.is_zero() {
            let reason = if built.taker_dust.is_zero() {
                Reason::Filled
            } else {
                Reason::FilledDust
            };
            taker.transition(OrderState::Settled, reason, now, &mut self.events)?;
            None
        } else {
            taker.props.set_amount(built.taker_live);
            taker.transition(OrderState::Open, Reason::PartialFill, now, &mut self.events)?;
            Some(taker)
        };

        let trade = HistoryTrade {
            info: built.info,
            txid,
            time: now,
        };
        self.history.push_front(trade.clone());
        self.history.truncate(self.limits.history_cap);
        Ok(Completion {
            trade,
            resubmit,
            fill: built.fill,
            taker_dust: built.taker_dust,
            maker_dust: built.maker_dust,
        })
    }

    /// The swap ended without settlement. The maker order is **unlocked and
    /// stays on the book** whoever caused the failure; the taker order is
    /// cancelled. (Legacy removed the maker order when the TERMINATE event
    /// *claimed* to come from the maker.)
    pub fn abort(&mut self, trade_id: TradeId, reason: Reason, now: u64) -> Result<Aborted, Error> {
        let pos = self
            .pending
            .iter()
            .position(|p| p.trade_id == trade_id)
            .ok_or(Error::UnknownTrade(trade_id))?;
        let p = self.pending.remove(pos);
        let mut maker_session = SessionId(0);
        if let Some(m) = self.orders.iter_mut().find(|o| o.id == p.maker_id) {
            maker_session = m.session;
            m.transition(OrderState::Open, reason, now, &mut self.events)?;
        }
        let mut taker = p.taker;
        taker.transition(OrderState::Cancelled, reason, now, &mut self.events)?;
        Ok(Aborted {
            trade_id,
            taker,
            maker_id: p.maker_id,
            maker_session,
        })
    }

    /// Trades whose swap started at or before `now - timeout`.
    pub fn expired(&self, now: u64, timeout_ms: u64) -> Vec<TradeId> {
        self.pending
            .iter()
            .filter(|p| now.saturating_sub(p.created_at) >= timeout_ms)
            .map(|p| p.trade_id)
            .collect()
    }

    pub fn has_trade(&self, trade_id: TradeId) -> bool {
        self.pending.iter().any(|p| p.trade_id == trade_id)
    }

    /// Legacy `removeOrder`, with authorization. Only the owning session can
    /// cancel, and only an order that is not locked in a swap.
    pub fn cancel(
        &mut self,
        id: OrderId,
        requester: SessionId,
        reason: Reason,
        now: u64,
    ) -> Result<Order, Error> {
        let idx = self
            .orders
            .iter()
            .position(|o| o.id == id)
            .ok_or(Error::NotFound(id))?;
        if self.orders[idx].session != requester {
            return Err(Error::NotAuthorized(id));
        }
        if self.orders[idx].is_locked() {
            return Err(Error::OrderLocked(id));
        }
        self.orders[idx].transition(OrderState::Cancelled, reason, now, &mut self.events)?;
        Ok(self.orders.remove(idx))
    }

    /// Whether the book holds `id`.
    pub fn contains(&self, id: OrderId) -> bool {
        self.orders.iter().any(|o| o.id == id)
    }
}
