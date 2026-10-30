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
//!
//! # Data structure
//!
//! Resting orders live in a `BTreeMap` keyed by an insertion sequence number
//! (iteration order = book order = legacy array order; a partially filled
//! maker keeps its number, a resting remainder gets a fresh, larger one).
//! Unlocked (`Open`) orders are also indexed per (action, market leg) by price
//! level, each level holding its sequence numbers, so the best candidate is
//! the first/last level and its smallest sequence number: price priority, then
//! time priority, in `O(log n)`. Locked orders are not in the price index.
//! Side depth and per-session load are counters; pending swaps are found by
//! trade id. Every lookup that used to be a linear `position` keeps its "first
//! match in book order" meaning.

use std::collections::btree_map::Values;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

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

/// Price-index group: (is sell side, kind, leg a, leg b). A spot order
/// `(desired, for_sale)` is filed under `(action, 0, desired, for_sale)`; a
/// futures order under `(action, 1, contract, 0)`.
type GroupKey = (bool, u8, u32, u32);

fn group_of(action: Action, props: &Props) -> GroupKey {
    let sell = action == Action::Sell;
    match props {
        Props::Spot(s) => (sell, 0, s.id_desired, s.id_for_sale),
        Props::Futures(f) => (sell, 1, f.contract_id, 0),
    }
}

/// Group a taker looks in: the opposite action with its legs mirrored.
fn counter_group_of(taker: &Order) -> GroupKey {
    let sell = taker.action.opposite() == Action::Sell;
    match &taker.props {
        Props::Spot(s) => (sell, 0, s.id_for_sale, s.id_desired),
        Props::Futures(f) => (sell, 1, f.contract_id, 0),
    }
}

fn side(action: Action) -> usize {
    match action {
        Action::Buy => 0,
        Action::Sell => 1,
    }
}

/// One market's resting orders, history and in-flight swaps.
#[derive(Debug, Clone)]
pub struct Orderbook {
    key: MarketKey,
    limits: Limits,
    /// Resting orders by insertion sequence number (= book order).
    orders: BTreeMap<u64, Order>,
    next_seq: u64,
    /// `(order id, seq)`, so the first order with an id is `range((id, 0)..)`.
    by_id: BTreeSet<(OrderId, u64)>,
    /// Price index of the `Open` orders: group -> price -> sequence numbers.
    levels: BTreeMap<GroupKey, BTreeMap<Price, BTreeSet<u64>>>,
    /// Resting orders per side (`side()` index).
    depth: [usize; 2],
    /// Resting orders plus in-flight takers per session.
    load: HashMap<SessionId, usize>,
    history: VecDeque<HistoryTrade>,
    /// In-flight swaps by creation number (= creation order).
    pending: BTreeMap<u64, Pending>,
    next_pending: u64,
    /// `(trade id, creation number)`.
    pending_by_trade: BTreeSet<(TradeId, u64)>,
    events: Vec<LifecycleEvent>,
}

impl Orderbook {
    pub fn new(key: MarketKey, limits: Limits) -> Orderbook {
        Orderbook {
            key,
            limits,
            orders: BTreeMap::new(),
            next_seq: 0,
            by_id: BTreeSet::new(),
            levels: BTreeMap::new(),
            depth: [0; 2],
            load: HashMap::new(),
            history: VecDeque::new(),
            pending: BTreeMap::new(),
            next_pending: 0,
            pending_by_trade: BTreeSet::new(),
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
        for o in orders {
            book.insert_order(o);
        }
        Ok(book)
    }

    pub fn key(&self) -> &MarketKey {
        &self.key
    }
    pub fn name(&self) -> String {
        self.key.name()
    }
    /// Resting orders in book (insertion) order.
    pub fn orders(&self) -> Values<'_, u64, Order> {
        self.orders.values()
    }
    /// Number of resting orders.
    pub fn order_count(&self) -> usize {
        self.orders.len()
    }
    /// No resting orders.
    pub fn is_empty(&self) -> bool {
        self.orders.is_empty()
    }
    /// Settled trades, newest first.
    pub fn history(&self) -> &VecDeque<HistoryTrade> {
        &self.history
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn side_depth(&self, action: Action) -> usize {
        self.depth[side(action)]
    }
    /// Resting orders plus in-flight takers owned by `session`.
    pub fn session_load(&self, session: SessionId) -> usize {
        self.load.get(&session).copied().unwrap_or(0)
    }
    /// Take and clear the lifecycle events recorded since the last call.
    pub fn take_events(&mut self) -> Vec<LifecycleEvent> {
        std::mem::take(&mut self.events)
    }
    pub fn check_compatible(&self, order: &Order) -> bool {
        self.key.compatible(&order.props)
    }

    // ----- storage helpers -------------------------------------------------

    fn bump_load(&mut self, session: SessionId) {
        *self.load.entry(session).or_insert(0) += 1;
    }

    fn drop_load(&mut self, session: SessionId) {
        if let Some(n) = self.load.get_mut(&session) {
            *n -= 1;
            if *n == 0 {
                self.load.remove(&session);
            }
        }
    }

    fn index(&mut self, seq: u64, group: GroupKey, price: Price) {
        self.levels
            .entry(group)
            .or_default()
            .entry(price)
            .or_default()
            .insert(seq);
    }

    fn unindex(&mut self, seq: u64, group: GroupKey, price: Price) {
        if let Some(prices) = self.levels.get_mut(&group) {
            if let Some(set) = prices.get_mut(&price) {
                set.remove(&seq);
                if set.is_empty() {
                    prices.remove(&price);
                }
            }
            if prices.is_empty() {
                self.levels.remove(&group);
            }
        }
    }

    /// Append `o` at the end of the book; returns its sequence number.
    fn insert_order(&mut self, o: Order) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.depth[side(o.action)] += 1;
        self.bump_load(o.session);
        self.by_id.insert((o.id, seq));
        if o.state == OrderState::Open {
            self.index(seq, group_of(o.action, &o.props), o.props.price());
        }
        self.orders.insert(seq, o);
        seq
    }

    /// Drop the order at `seq` from every structure.
    fn remove_order(&mut self, seq: u64) -> Option<Order> {
        let o = self.orders.remove(&seq)?;
        if o.state == OrderState::Open {
            self.unindex(seq, group_of(o.action, &o.props), o.props.price());
        }
        self.depth[side(o.action)] -= 1;
        self.drop_load(o.session);
        self.by_id.remove(&(o.id, seq));
        Some(o)
    }

    /// Sequence number of the first order with `id` in book order.
    fn seq_of(&self, id: OrderId) -> Option<u64> {
        self.by_id
            .range((id, 0)..=(id, u64::MAX))
            .next()
            .map(|&(_, seq)| seq)
    }

    /// Run `f` on the order at `seq`, keeping the price index in step with
    /// its state (indexed exactly while `Open`).
    fn mutate<F>(&mut self, seq: u64, f: F) -> Result<(), Error>
    where
        F: FnOnce(&mut Order, &mut Vec<LifecycleEvent>) -> Result<(), Error>,
    {
        let Some(o) = self.orders.get_mut(&seq) else {
            return Err(Error::IllegalTransition); // unreachable: callers hold a live seq
        };
        let group = group_of(o.action, &o.props);
        let price = o.props.price();
        let was_open = o.state == OrderState::Open;
        let res = f(o, &mut self.events);
        let is_open = o.state == OrderState::Open;
        if was_open && !is_open {
            self.unindex(seq, group, price);
        } else if !was_open && is_open {
            self.index(seq, group, price);
        }
        res
    }

    fn push_pending(&mut self, p: Pending) {
        let n = self.next_pending;
        self.next_pending += 1;
        self.bump_load(p.taker.session);
        self.pending_by_trade.insert((p.trade_id, n));
        self.pending.insert(n, p);
    }

    /// Creation number of the oldest pending swap with `trade_id`.
    fn pending_of(&self, trade_id: TradeId) -> Option<u64> {
        self.pending_by_trade
            .range((trade_id, 0)..=(trade_id, u64::MAX))
            .next()
            .map(|&(_, n)| n)
    }

    fn take_pending(&mut self, n: u64) -> Option<Pending> {
        let p = self.pending.remove(&n)?;
        self.pending_by_trade.remove(&(p.trade_id, n));
        self.drop_load(p.taker.session);
        Some(p)
    }

    /// Sequence number of the best crossing resting order (before the
    /// self-match checks, which `find_match` applies).
    fn best_seq(&self, taker: &Order) -> Option<u64> {
        let prices = self.levels.get(&counter_group_of(taker))?;
        let t_price = taker.props.price();
        // Lowest ask for a buy taker, highest bid for a sell taker; within the
        // level the smallest sequence number is the earliest in book order.
        let (_, seqs) = match taker.action {
            Action::Buy => prices.iter().next().filter(|(p, _)| **p <= t_price),
            Action::Sell => prices.iter().next_back().filter(|(p, _)| **p >= t_price),
        }?;
        seqs.iter().next().copied()
    }

    /// Legacy `checkMatch`: id of the best crossing resting order.
    pub fn find_match(&self, taker: &Order) -> Result<Option<OrderId>, Error> {
        match self.find_seq(taker)? {
            None => Ok(None),
            Some(seq) => Ok(self.orders.get(&seq).map(|o| o.id)),
        }
    }

    fn find_seq(&self, taker: &Order) -> Result<Option<u64>, Error> {
        let Some(seq) = self.best_seq(taker) else {
            return Ok(None);
        };
        let Some(m) = self.orders.get(&seq) else {
            return Ok(None); // unreachable: the index only holds live orders
        };
        if m.session == taker.session {
            return Err(Error::SameAccount);
        }
        if m.keypair.address == taker.keypair.address {
            return Err(Error::SameAddress);
        }
        Ok(Some(seq))
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
        match self.find_seq(order)? {
            None => {
                if self.side_depth(order.action) >= self.limits.max_side_depth {
                    return Err(Error::BookFull);
                }
                if order.state == OrderState::New {
                    order.transition(OrderState::Open, Reason::Placed, now, &mut self.events)?;
                }
                self.insert_order(order.clone());
                Ok(SubmitOutcome::Placed(order.clone()))
            }
            Some(seq) => {
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
                let maker = self.orders.get(&seq).ok_or(Error::IllegalTransition)?;
                let built = build_trade(order, maker, self.limits.min_amount)?;
                let maker_id = maker.id;
                self.mutate(seq, |m, ev| {
                    m.transition(OrderState::LockedInSwap, Reason::Matched, now, ev)
                })?;
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
                self.push_pending(Pending {
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
        let pn = self
            .pending_of(trade_id)
            .ok_or(Error::UnknownTrade(trade_id))?;
        let maker_id = self
            .pending
            .get(&pn)
            .map(|p| p.maker_id)
            .ok_or(Error::UnknownTrade(trade_id))?;
        let mseq = self.seq_of(maker_id).ok_or(Error::NotFound(maker_id))?;
        let p = self.take_pending(pn).ok_or(Error::UnknownTrade(trade_id))?;
        let built = p.built;

        if built.maker_live.is_zero() {
            let reason = if built.maker_dust.is_zero() {
                Reason::Filled
            } else {
                Reason::FilledDust
            };
            self.mutate(mseq, |m, ev| {
                m.transition(OrderState::Settled, reason, now, ev)
            })?;
            self.remove_order(mseq);
        } else {
            let live = built.maker_live;
            self.mutate(mseq, |m, ev| {
                m.props.set_amount(live);
                m.transition(OrderState::Open, Reason::PartialFill, now, ev)
            })?;
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
        let pn = self
            .pending_of(trade_id)
            .ok_or(Error::UnknownTrade(trade_id))?;
        let p = self.take_pending(pn).ok_or(Error::UnknownTrade(trade_id))?;
        let mut maker_session = SessionId(0);
        if let Some(mseq) = self.seq_of(p.maker_id) {
            if let Some(m) = self.orders.get(&mseq) {
                maker_session = m.session;
            }
            self.mutate(mseq, |m, ev| {
                m.transition(OrderState::Open, reason, now, ev)
            })?;
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
            .values()
            .filter(|p| now.saturating_sub(p.created_at) >= timeout_ms)
            .map(|p| p.trade_id)
            .collect()
    }

    pub fn has_trade(&self, trade_id: TradeId) -> bool {
        self.pending_of(trade_id).is_some()
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
        let seq = self.seq_of(id).ok_or(Error::NotFound(id))?;
        let o = self.orders.get(&seq).ok_or(Error::NotFound(id))?;
        if o.session != requester {
            return Err(Error::NotAuthorized(id));
        }
        if o.is_locked() {
            return Err(Error::OrderLocked(id));
        }
        self.mutate(seq, |o, ev| {
            o.transition(OrderState::Cancelled, reason, now, ev)
        })?;
        self.remove_order(seq).ok_or(Error::NotFound(id))
    }

    /// Whether the book holds `id`.
    pub fn contains(&self, id: OrderId) -> bool {
        self.seq_of(id).is_some()
    }
}
