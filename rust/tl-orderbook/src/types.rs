//! Typed orders. Ports `src/utils/types/orderbook.types.ts` and
//! `markets.types.ts` (the `TFilter` part).
//!
//! Wire-name notes: the TS field `levarage` (sic) is `leverage` here; the
//! TS `uuid`/`socket_id` strings are `u64` newtypes assigned by the server and
//! the transport respectively.

use std::fmt;

use crate::amount::{Amount, Price};

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub u64);
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

id_type!(
    /// Server-assigned order id (legacy: uuid v4 string).
    OrderId
);
id_type!(
    /// Transport-assigned connection id (legacy: socket.io `socket.id`).
    SessionId
);
id_type!(
    /// Server-assigned id of one match / swap (legacy later branch: `tradeId`).
    TradeId
);

/// `EOrderAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Buy,
    Sell,
}

impl Action {
    pub fn opposite(self) -> Action {
        match self {
            Action::Buy => Action::Sell,
            Action::Sell => Action::Buy,
        }
    }
    pub fn wire(self) -> &'static str {
        match self {
            Action::Buy => "BUY",
            Action::Sell => "SELL",
        }
    }
    pub fn from_wire(s: &str) -> Option<Action> {
        match s {
            "BUY" => Some(Action::Buy),
            "SELL" => Some(Action::Sell),
            _ => None,
        }
    }
}

/// `EOrderType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarketKind {
    Spot,
    Futures,
}

impl MarketKind {
    pub fn wire(self) -> &'static str {
        match self {
            MarketKind::Spot => "SPOT",
            MarketKind::Futures => "FUTURES",
        }
    }
}

/// `IKeyPair`: the trader's settlement address and public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keypair {
    pub address: String,
    pub pubkey: String,
}

/// `ISpotOrderProps`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotProps {
    pub id_desired: u32,
    pub id_for_sale: u32,
    pub amount: Amount,
    pub price: Price,
}

/// `IFuturesOrderProps`. `leverage` is the legacy `levarage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FuturesProps {
    pub contract_id: u32,
    pub amount: Amount,
    pub price: Price,
    pub leverage: Amount,
    pub collateral: u32,
}

/// Spot or futures order properties (`order.type` + `order.props`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Props {
    Spot(SpotProps),
    Futures(FuturesProps),
}

impl Props {
    pub fn kind(&self) -> MarketKind {
        match self {
            Props::Spot(_) => MarketKind::Spot,
            Props::Futures(_) => MarketKind::Futures,
        }
    }
    pub fn amount(&self) -> Amount {
        match self {
            Props::Spot(p) => p.amount,
            Props::Futures(p) => p.amount,
        }
    }
    pub fn price(&self) -> Price {
        match self {
            Props::Spot(p) => p.price,
            Props::Futures(p) => p.price,
        }
    }
    pub fn set_amount(&mut self, amount: Amount) {
        match self {
            Props::Spot(p) => p.amount = amount,
            Props::Futures(p) => p.amount = amount,
        }
    }
}

/// `TRawOrder`: what a client sends in `new-order` / `many-orders`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawOrder {
    pub keypair: Keypair,
    pub action: Action,
    pub is_limit_order: bool,
    pub market_name: String,
    pub props: Props,
}

/// Lifecycle state of an order; see [`crate::lifecycle`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OrderState {
    /// Accepted by the server, not yet on the book or matched.
    New,
    /// Resting on the book and available for matching.
    Open,
    /// Matched; an atomic swap with the counterparty is in progress
    /// (legacy `lock = true`).
    LockedInSwap,
    /// Fully filled by settled swaps (terminal).
    Settled,
    /// Cancelled, rejected, or abandoned (terminal).
    Cancelled,
}

/// `TOrder`: a raw order plus server-built fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub session: SessionId,
    pub keypair: Keypair,
    pub action: Action,
    pub market_name: String,
    pub timestamp: u64,
    pub props: Props,
    pub state: OrderState,
}

impl Order {
    /// Legacy `order.lock`.
    pub fn is_locked(&self) -> bool {
        self.state == OrderState::LockedInSwap
    }
}

/// `TFilter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Spot { first_token: u32, second_token: u32 },
    Futures { contract_id: u32 },
}
