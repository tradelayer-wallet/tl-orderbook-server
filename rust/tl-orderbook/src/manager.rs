//! A book manager over multiple markets.
//!
//! Ports `src/services/orderbook/manager.class.ts` (`OrderbookManager`):
//! books are created lazily by the first compatible order, orders are found
//! by id across books, and orders can be listed per session. Log-file
//! history (`getOrdersHistory`) becomes the lifecycle event stream.

use std::collections::BTreeMap;

use crate::book::{Aborted, Completion, MarketKey, Orderbook, SubmitOutcome};
use crate::error::Error;
use crate::lifecycle::{LifecycleEvent, Reason};
use crate::types::{Filter, Order, OrderId, OrderState, SessionId, TradeId};
use crate::validate::Limits;

#[derive(Debug)]
pub struct OrderbookManager {
    limits: Limits,
    books: Vec<Orderbook>,
    /// trade id -> index into `books`
    trades: BTreeMap<TradeId, usize>,
    next_trade: u64,
    events: Vec<LifecycleEvent>,
}

impl OrderbookManager {
    pub fn new(limits: Limits) -> OrderbookManager {
        OrderbookManager {
            limits,
            books: Vec::new(),
            trades: BTreeMap::new(),
            next_trade: 1,
            events: Vec::new(),
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }
    pub fn books(&self) -> &[Orderbook] {
        &self.books
    }
    pub fn pending_swaps(&self) -> usize {
        self.trades.len()
    }

    /// Register an already-built book (restore / fixtures).
    pub fn insert_book(&mut self, book: Orderbook) -> Result<(), Error> {
        if self.books.len() >= self.limits.max_books {
            return Err(Error::TooManyBooks);
        }
        self.books.push(book);
        Ok(())
    }

    fn drain_book_events(&mut self, idx: usize) {
        let ev = self.books[idx].take_events();
        self.events.extend(ev);
        // bounded: callers drain after every operation
    }

    /// Take and clear the lifecycle events since the last call.
    pub fn take_events(&mut self) -> Vec<LifecycleEvent> {
        std::mem::take(&mut self.events)
    }

    /// Open orders owned by `session` plus swaps it takes part in.
    pub fn session_load(&self, session: SessionId) -> usize {
        self.books.iter().map(|b| b.session_load(session)).sum()
    }

    /// Legacy `OrderbookManager.addOrder`: route to the compatible book,
    /// creating it for the first order of a market.
    ///
    /// A `New` order is also subject to the per-session order cap (a
    /// remainder re-entering the book is not counted twice).
    pub fn submit(
        &mut self,
        order: Order,
        no_trades: bool,
        now: u64,
    ) -> Result<SubmitOutcome, Error> {
        if order.state == OrderState::New
            && self.session_load(order.session) >= self.limits.max_orders_per_session
        {
            return Err(Error::SessionOrderLimit);
        }
        let existing = self.books.iter().position(|b| b.check_compatible(&order));
        let (idx, created) = match existing {
            Some(i) => (i, false),
            None => {
                if self.books.len() >= self.limits.max_books {
                    return Err(Error::TooManyBooks);
                }
                let key = MarketKey::from_props(&order.props);
                self.books.push(Orderbook::new(key, self.limits.clone()));
                (self.books.len() - 1, true)
            }
        };
        let trade_id = TradeId(self.next_trade);
        let res = self.books[idx].submit(order, no_trades, trade_id, now);
        self.drain_book_events(idx);
        match &res {
            Ok(SubmitOutcome::Matched(_)) => {
                self.next_trade = self.next_trade.saturating_add(1);
                self.trades.insert(trade_id, idx);
            }
            Ok(_) => {}
            Err(_) => {
                if created && self.books[idx].is_empty() {
                    self.books.pop();
                }
            }
        }
        res
    }

    fn book_of_trade(&self, trade_id: TradeId) -> Result<usize, Error> {
        self.trades
            .get(&trade_id)
            .copied()
            .ok_or(Error::UnknownTrade(trade_id))
    }

    /// The swap for `trade_id` settled.
    pub fn complete(
        &mut self,
        trade_id: TradeId,
        txid: String,
        now: u64,
    ) -> Result<Completion, Error> {
        let idx = self.book_of_trade(trade_id)?;
        let res = self.books[idx].complete(trade_id, txid, now);
        self.drain_book_events(idx);
        if res.is_ok() {
            self.trades.remove(&trade_id);
        }
        res
    }

    /// The swap for `trade_id` ended without settlement.
    pub fn abort(&mut self, trade_id: TradeId, reason: Reason, now: u64) -> Result<Aborted, Error> {
        let idx = self.book_of_trade(trade_id)?;
        let res = self.books[idx].abort(trade_id, reason, now);
        self.drain_book_events(idx);
        if res.is_ok() {
            self.trades.remove(&trade_id);
        }
        res
    }

    /// Legacy `OrderbookManager.removeOrder`: find the order in any book and
    /// cancel it on behalf of `requester`.
    pub fn cancel(
        &mut self,
        id: OrderId,
        requester: SessionId,
        reason: Reason,
        now: u64,
    ) -> Result<Order, Error> {
        let idx = self
            .books
            .iter()
            .position(|b| b.contains(id))
            .ok_or(Error::NotFound(id))?;
        let res = self.books[idx].cancel(id, requester, reason, now);
        self.drain_book_events(idx);
        res
    }

    /// Legacy `getOrdersBySocketId`.
    pub fn orders_by_session(&self, session: SessionId) -> Vec<Order> {
        self.books
            .iter()
            .flat_map(|b| b.orders())
            .filter(|o| o.session == session)
            .cloned()
            .collect()
    }

    /// Legacy `orderbooks.find(b => b.findByFilter(filter))`.
    pub fn find_by_filter(&self, filter: &Filter) -> Option<&Orderbook> {
        self.books.iter().find(|b| b.key().matches_filter(filter))
    }

    /// Trade ids whose swap has exceeded the timeout.
    pub fn expired_trades(&self, now: u64) -> Vec<TradeId> {
        self.books
            .iter()
            .flat_map(|b| b.expired(now, self.limits.swap_timeout_ms))
            .collect()
    }
}
