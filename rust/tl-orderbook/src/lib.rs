//! `tl-orderbook`: a std-only port of the TradeLayer external orderbook
//! server (`tl-orderbook-server`).
//!
//! This is the **external, off-chain** order matching service that pairs
//! wallets for atomic swaps. It is not consensus matching: the chain's own
//! order matching lives in `tradelayer-core` and is out of scope here. This
//! crate captures what the external service does: order events, price-time
//! priority matching, the swap request built for each match, the settlement
//! lifecycle of an order, and the socket protocol around it.
//!
//! See `README.md` for the legacy-versus-Rust difference table.

#![forbid(unsafe_code)]

pub mod amount;
pub mod book;
pub mod error;
pub mod lifecycle;
pub mod manager;
pub mod socket;
pub mod swap;
pub mod types;
pub mod validate;

pub use amount::{notional, Amount, Price, MAX_RAW, SCALE};
pub use book::{
    build_trade, Aborted, BuiltTrade, Completion, HistoryTrade, MarketKey, Orderbook, SubmitOutcome,
    SwapRequest, TradeInfo, TradeParty, TradeProps,
};
pub use error::Error;
pub use lifecycle::{edge_allowed, is_terminal, LifecycleEvent, Reason};
pub use manager::OrderbookManager;
pub use socket::{ClientEvent, Dest, Outbound, Server, ServerEvent, SessionInfo, SessionManager};
pub use swap::{SwapAction, SwapKind, SwapMsg, SwapState};
pub use types::{
    Action, Filter, FuturesProps, Keypair, MarketKind, Order, OrderId, OrderState, Props,
    RawOrder, SessionId, SpotProps, TradeId,
};
pub use validate::{validate, Limits};
