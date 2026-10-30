//! One typed error for the whole crate. No function in this crate panics on
//! untrusted input; every failure is one of these variants.

use std::fmt;

use crate::types::{OrderId, TradeId};

/// Every way an operation can be refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    // ---- decimal handling ----
    /// Text is not a plain non-negative decimal.
    BadDecimal,
    /// More than six fractional digits.
    TooManyDecimals,
    /// Value exceeds `MAX_RAW` (1e9 whole units).
    AmountTooLarge,
    /// A float that is not exactly a six-decimal number.
    NotRepresentable,
    /// `amount * price` does not fit the bounded amount range.
    NotionalOverflow,
    // ---- order validation ----
    MarketOrdersNotAllowed,
    ZeroAmount,
    BelowMinimum,
    ZeroPrice,
    BadKeypair(&'static str),
    BadMarketName,
    SameAssetPair,
    BadLeverage,
    // ---- book ----
    /// Legacy text: "Order missmatch current orderbook interface or type".
    Mismatch,
    /// Legacy text: "Match of the order from the same Account".
    SameAccount,
    /// Legacy text: "Match of the order from the same address".
    SameAddress,
    SessionOrderLimit,
    BookFull,
    TooManyBooks,
    BatchTooLarge,
    NotFound(OrderId),
    NotAuthorized(OrderId),
    OrderLocked(OrderId),
    /// A lifecycle edge that is not in the allowed set was requested.
    IllegalTransition,
    // ---- swap ----
    UnknownTrade(TradeId),
    NotParticipant,
    BadSwapEvent,
    WrongRole,
    StepOutOfOrder { expected: u8, got: u8 },
    PayloadTooLarge,
    BadTxid,
    TooManySwaps,
    SessionSwapLimit,
    // ---- sessions ----
    UnknownSession,
    TooManySessions,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::BadDecimal => write!(f, "not a plain decimal number"),
            Error::TooManyDecimals => write!(f, "more than 6 decimal places"),
            Error::AmountTooLarge => write!(f, "value exceeds the supported maximum"),
            Error::NotRepresentable => write!(f, "number is not an exact 6-decimal value"),
            Error::NotionalOverflow => write!(f, "amount * price is out of range"),
            Error::MarketOrdersNotAllowed => write!(f, "Market orders not allowed"),
            Error::ZeroAmount => write!(f, "order amount must be positive"),
            Error::BelowMinimum => write!(f, "order amount is below the minimum size"),
            Error::ZeroPrice => write!(f, "order price must be positive"),
            Error::BadKeypair(why) => write!(f, "invalid keypair: {why}"),
            Error::BadMarketName => write!(f, "invalid market name"),
            Error::SameAssetPair => write!(f, "spot order trades an asset against itself"),
            Error::BadLeverage => write!(f, "leverage must be positive"),
            Error::Mismatch => write!(f, "Order missmatch current orderbook interface or type"),
            Error::SameAccount => write!(f, "Match of the order from the same Account"),
            Error::SameAddress => write!(f, "Match of the order from the same address"),
            Error::SessionOrderLimit => write!(f, "too many open orders for this session"),
            Error::BookFull => write!(f, "orderbook side is full"),
            Error::TooManyBooks => write!(f, "too many orderbooks"),
            Error::BatchTooLarge => write!(f, "too many orders in one batch"),
            Error::NotFound(id) => write!(f, "Order with uuid: {id} dont exist"),
            Error::NotAuthorized(id) => {
                write!(f, "Not Authorized to remove order with uuid: {id}")
            }
            Error::OrderLocked(id) => write!(f, "Order {id} is locked in a swap"),
            Error::IllegalTransition => write!(f, "illegal order lifecycle transition"),
            Error::UnknownTrade(id) => write!(f, "unknown or finished trade {id}"),
            Error::NotParticipant => write!(f, "session is not a participant of this trade"),
            Error::BadSwapEvent => write!(f, "unrecognised swap event"),
            Error::WrongRole => write!(f, "swap step sent by the wrong side"),
            Error::StepOutOfOrder { expected, got } => {
                write!(f, "swap step {got} received, expected step {expected}")
            }
            Error::PayloadTooLarge => write!(f, "swap payload too large"),
            Error::BadTxid => write!(f, "settlement txid must be 64 hex characters"),
            Error::TooManySwaps => write!(f, "too many swaps in flight"),
            Error::SessionSwapLimit => write!(f, "too many swaps in flight for this session"),
            Error::UnknownSession => write!(f, "unknown session"),
            Error::TooManySessions => write!(f, "too many sessions"),
        }
    }
}

impl std::error::Error for Error {}
