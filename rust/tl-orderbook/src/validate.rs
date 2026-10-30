//! Resource limits and order validation.
//!
//! The legacy server validated only `isLimitOrder` (`socket/manager.class.ts`
//! `onNewOrder`). Everything else here is new and listed in the README
//! difference table.

use crate::amount::{notional, Amount};
use crate::error::Error;
use crate::types::{Keypair, Props, RawOrder};

/// Bounds on work per connection, per book and per swap.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Smallest accepted order amount; also the dust threshold for remainders.
    pub min_amount: Amount,
    /// Open orders (resting + in-flight takers) one session may hold.
    pub max_orders_per_session: usize,
    /// Resting orders per side per book.
    pub max_side_depth: usize,
    /// Distinct markets.
    pub max_books: usize,
    /// Orders per `many-orders` batch.
    pub max_batch: usize,
    /// Concurrent sessions.
    pub max_sessions: usize,
    /// Swaps in flight, total.
    pub max_pending_swaps: usize,
    /// Swaps in flight in which one session participates.
    pub max_swaps_per_session: usize,
    /// A swap with no settlement after this long is aborted and unlocked.
    pub swap_timeout_ms: u64,
    /// Trades remembered per book (legacy: 2000).
    pub history_cap: usize,
    /// Lifecycle events remembered by the server (legacy: 500 order-log lines).
    pub order_log_cap: usize,
    /// Undelivered outbound events kept; later events are counted and dropped.
    pub outbox_cap: usize,
    /// Bytes of one relayed swap payload.
    pub max_swap_payload: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            min_amount: Amount::from_raw(1_000).unwrap_or(Amount::ZERO),
            max_orders_per_session: 100,
            max_side_depth: 1_000,
            max_books: 64,
            max_batch: 100,
            max_sessions: 10_000,
            max_pending_swaps: 1_000,
            max_swaps_per_session: 4,
            swap_timeout_ms: 10 * 60 * 1000,
            history_cap: 2_000,
            order_log_cap: 500,
            outbox_cap: 100_000,
            max_swap_payload: 256 * 1024,
        }
    }
}

const MAX_ADDRESS_LEN: usize = 100;
const MAX_MARKET_NAME_LEN: usize = 64;
const MAX_LEVERAGE_RAW: u64 = 1_000 * crate::amount::SCALE;

fn validate_keypair(k: &Keypair) -> Result<(), Error> {
    if k.address.is_empty() || k.address.len() > MAX_ADDRESS_LEN {
        return Err(Error::BadKeypair("address length"));
    }
    if !k.address.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(Error::BadKeypair("address characters"));
    }
    let l = k.pubkey.len();
    if (l != 66 && l != 130) || !k.pubkey.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::BadKeypair("pubkey must be 33 or 65 bytes of hex"));
    }
    Ok(())
}

/// Validate a client order against `limits`. Pure; does not touch any book.
pub fn validate(raw: &RawOrder, limits: &Limits) -> Result<(), Error> {
    if !raw.is_limit_order {
        return Err(Error::MarketOrdersNotAllowed);
    }
    validate_keypair(&raw.keypair)?;
    if raw.market_name.len() > MAX_MARKET_NAME_LEN
        || !raw
            .market_name
            .bytes()
            .all(|b| b.is_ascii_graphic() || b == b' ')
    {
        return Err(Error::BadMarketName);
    }
    let amount = raw.props.amount();
    if amount.is_zero() {
        return Err(Error::ZeroAmount);
    }
    if amount < limits.min_amount {
        return Err(Error::BelowMinimum);
    }
    if raw.props.price().is_zero() {
        return Err(Error::ZeroPrice);
    }
    // amount * price must stay in range so that every later fill can be built.
    notional(amount, raw.props.price())?;
    match &raw.props {
        Props::Spot(p) => {
            if p.id_desired == p.id_for_sale {
                return Err(Error::SameAssetPair);
            }
        }
        Props::Futures(p) => {
            if p.leverage.is_zero() || p.leverage.raw() > MAX_LEVERAGE_RAW {
                return Err(Error::BadLeverage);
            }
        }
    }
    Ok(())
}
