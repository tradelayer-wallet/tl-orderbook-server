//! The swap-channel relay state machine.
//!
//! Ports `src/services/channel-swap/channel-swap.class.ts`. The legacy relay
//! forwarded every `${id}::swap` event to the counterparty and only inspected
//! two event names: `BUYER:STEP6` (settled, payload = txid) and
//! `TERMINATE_TRADE`. It never checked who sent an event, which step came
//! before, or that the event belonged to this trade, and it trusted the
//! `socketId` *inside* the event to decide who terminated.
//!
//! The wallet clients (`tradelayer-wallet` `swapper/{buyer,seller}.ts`) run a
//! fixed six-step protocol that alternates sides:
//! `SELLER:STEP1, BUYER:STEP2, SELLER:STEP3, BUYER:STEP4, SELLER:STEP5, BUYER:STEP6`.
//!
//! Here every message names its trade; the sender is the authenticated
//! session supplied by the transport (never a payload field); step `n` is
//! accepted only from the right side and only after step `n-1`.

use crate::error::Error;
use crate::types::{SessionId, TradeId};

/// Legacy wire name of the abort event.
pub const TERMINATE_WIRE: &str = "TERMINATE_TRADE";
/// Number of protocol steps.
pub const LAST_STEP: u8 = 6;

/// What a swap message says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapKind {
    /// `SELLER:STEPn` (n odd) or `BUYER:STEPn` (n even).
    Step(u8),
    /// `TERMINATE_TRADE`.
    Terminate,
}

impl SwapKind {
    /// Parse a legacy event name. Anything else is refused.
    pub fn from_wire(name: &str) -> Result<SwapKind, Error> {
        if name == TERMINATE_WIRE {
            return Ok(SwapKind::Terminate);
        }
        let (role_is_seller, rest) = if let Some(r) = name.strip_prefix("SELLER:STEP") {
            (true, r)
        } else if let Some(r) = name.strip_prefix("BUYER:STEP") {
            (false, r)
        } else {
            return Err(Error::BadSwapEvent);
        };
        if rest.len() != 1 {
            return Err(Error::BadSwapEvent);
        }
        let n = rest.as_bytes()[0];
        if !(b'1'..=b'6').contains(&n) {
            return Err(Error::BadSwapEvent);
        }
        let n = n - b'0';
        // the prefix must agree with the parity of the step number
        if role_is_seller != (n % 2 == 1) {
            return Err(Error::BadSwapEvent);
        }
        Ok(SwapKind::Step(n))
    }

    /// Legacy event name.
    pub fn wire(&self) -> String {
        match self {
            SwapKind::Terminate => TERMINATE_WIRE.to_string(),
            SwapKind::Step(n) if n % 2 == 1 => format!("SELLER:STEP{n}"),
            SwapKind::Step(n) => format!("BUYER:STEP{n}"),
        }
    }
}

/// One swap message from a client (`SwapEvent` in the TS, plus the trade id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapMsg {
    pub trade_id: TradeId,
    pub kind: SwapKind,
    /// Opaque step data (psbt hex, ...), the txid for step 6, or the
    /// termination reason.
    pub payload: String,
}

/// What the server must do after an accepted message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapAction {
    /// Forward the message to this session.
    Relay { to: SessionId },
    /// Step 6 accepted: the swap settled with this txid.
    Settle { txid: String },
    /// A participant ended the trade.
    Terminated { by: SessionId, reason: String },
}

/// Per-trade protocol state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapState {
    pub trade_id: TradeId,
    pub buyer: SessionId,
    pub seller: SessionId,
    /// Highest step accepted so far (0 = none).
    pub last_step: u8,
    pub started_at: u64,
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl SwapState {
    pub fn new(trade_id: TradeId, buyer: SessionId, seller: SessionId, now: u64) -> SwapState {
        SwapState {
            trade_id,
            buyer,
            seller,
            last_step: 0,
            started_at: now,
        }
    }

    pub fn involves(&self, s: SessionId) -> bool {
        s == self.buyer || s == self.seller
    }

    /// The side that must send step `n`: odd steps come from the seller,
    /// even steps from the buyer.
    pub fn sender_for(&self, n: u8) -> SessionId {
        if n % 2 == 1 {
            self.seller
        } else {
            self.buyer
        }
    }

    /// Decide on a message. On error the state is unchanged.
    pub fn on_message(
        &mut self,
        from: SessionId,
        msg: &SwapMsg,
        max_payload: usize,
    ) -> Result<SwapAction, Error> {
        if msg.trade_id != self.trade_id {
            return Err(Error::UnknownTrade(msg.trade_id));
        }
        if !self.involves(from) {
            return Err(Error::NotParticipant);
        }
        if msg.payload.len() > max_payload {
            return Err(Error::PayloadTooLarge);
        }
        match msg.kind {
            SwapKind::Terminate => Ok(SwapAction::Terminated {
                by: from,
                reason: msg.payload.clone(),
            }),
            SwapKind::Step(n) => {
                if !(1..=LAST_STEP).contains(&n) {
                    return Err(Error::BadSwapEvent);
                }
                if self.sender_for(n) != from {
                    return Err(Error::WrongRole);
                }
                let expected = self.last_step + 1;
                if n != expected {
                    return Err(Error::StepOutOfOrder { expected, got: n });
                }
                if n == LAST_STEP {
                    if !is_txid(&msg.payload) {
                        return Err(Error::BadTxid);
                    }
                    self.last_step = n;
                    return Ok(SwapAction::Settle {
                        txid: msg.payload.clone(),
                    });
                }
                self.last_step = n;
                let to = if from == self.buyer {
                    self.seller
                } else {
                    self.buyer
                };
                Ok(SwapAction::Relay { to })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: SessionId = SessionId(1);
    const S: SessionId = SessionId(2);
    const TXID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn msg(kind: SwapKind, payload: &str) -> SwapMsg {
        SwapMsg {
            trade_id: TradeId(7),
            kind,
            payload: payload.to_string(),
        }
    }

    fn state() -> SwapState {
        SwapState::new(TradeId(7), B, S, 0)
    }

    #[test]
    fn wire_names_round_trip() {
        for n in 1..=6u8 {
            let k = SwapKind::Step(n);
            assert_eq!(SwapKind::from_wire(&k.wire()), Ok(k));
        }
        assert_eq!(
            SwapKind::from_wire("TERMINATE_TRADE"),
            Ok(SwapKind::Terminate)
        );
        assert_eq!(SwapKind::wire(&SwapKind::Step(5)), "SELLER:STEP5");
        assert_eq!(SwapKind::wire(&SwapKind::Step(6)), "BUYER:STEP6");
    }

    #[test]
    fn wire_names_reject_garbage() {
        for bad in [
            "",
            "STEP1",
            "SELLER:STEP0",
            "SELLER:STEP7",
            "SELLER:STEP2",
            "BUYER:STEP1",
            "BUYER:STEP12",
            "SELLER:STEP",
            "buyer:step2",
            "TERMINATE",
            "SELLER:STEP1 ",
        ] {
            assert_eq!(
                SwapKind::from_wire(bad),
                Err(Error::BadSwapEvent),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn happy_path_runs_six_steps_in_order() {
        let mut s = state();
        let seq = [(S, 1), (B, 2), (S, 3), (B, 4), (S, 5)];
        for (from, n) in seq {
            let a = s
                .on_message(from, &msg(SwapKind::Step(n), "x"), 100)
                .unwrap();
            let to = if from == B { S } else { B };
            assert_eq!(a, SwapAction::Relay { to });
        }
        let a = s.on_message(B, &msg(SwapKind::Step(6), TXID), 100).unwrap();
        assert_eq!(
            a,
            SwapAction::Settle {
                txid: TXID.to_string()
            }
        );
        assert_eq!(s.last_step, 6);
    }

    #[test]
    fn step5_requires_step4() {
        let mut s = state();
        s.on_message(S, &msg(SwapKind::Step(1), "x"), 100).unwrap();
        s.on_message(B, &msg(SwapKind::Step(2), "x"), 100).unwrap();
        s.on_message(S, &msg(SwapKind::Step(3), "x"), 100).unwrap();
        // step 4 never happened
        assert_eq!(
            s.on_message(S, &msg(SwapKind::Step(5), "x"), 100),
            Err(Error::StepOutOfOrder {
                expected: 4,
                got: 5
            })
        );
        assert_eq!(s.last_step, 3);
    }

    #[test]
    fn step6_cannot_skip_ahead() {
        let mut s = state();
        assert_eq!(
            s.on_message(B, &msg(SwapKind::Step(6), TXID), 100),
            Err(Error::StepOutOfOrder {
                expected: 1,
                got: 6
            })
        );
    }

    #[test]
    fn wrong_side_and_repeat_are_refused() {
        let mut s = state();
        assert_eq!(
            s.on_message(B, &msg(SwapKind::Step(1), "x"), 100),
            Err(Error::WrongRole)
        );
        s.on_message(S, &msg(SwapKind::Step(1), "x"), 100).unwrap();
        assert_eq!(
            s.on_message(S, &msg(SwapKind::Step(1), "x"), 100),
            Err(Error::StepOutOfOrder {
                expected: 2,
                got: 1
            })
        );
    }

    #[test]
    fn outsider_and_wrong_trade_are_refused() {
        let mut s = state();
        assert_eq!(
            s.on_message(SessionId(99), &msg(SwapKind::Terminate, "x"), 100),
            Err(Error::NotParticipant)
        );
        let mut m = msg(SwapKind::Step(1), "x");
        m.trade_id = TradeId(8);
        assert_eq!(
            s.on_message(S, &m, 100),
            Err(Error::UnknownTrade(TradeId(8)))
        );
    }

    #[test]
    fn terminate_attributes_to_the_authenticated_sender() {
        let mut s = state();
        // The payload may *claim* to be from anyone; the actor is `from`.
        let a = s
            .on_message(B, &msg(SwapKind::Terminate, "socket 2 gave up"), 100)
            .unwrap();
        assert_eq!(
            a,
            SwapAction::Terminated {
                by: B,
                reason: "socket 2 gave up".into()
            }
        );
    }

    #[test]
    fn bad_txid_and_big_payload_are_refused() {
        let mut s = state();
        for (from, n) in [(S, 1), (B, 2), (S, 3), (B, 4), (S, 5)] {
            s.on_message(from, &msg(SwapKind::Step(n), "x"), 100)
                .unwrap();
        }
        assert_eq!(
            s.on_message(B, &msg(SwapKind::Step(6), "not-a-txid"), 100),
            Err(Error::BadTxid)
        );
        assert_eq!(s.last_step, 5);
        assert_eq!(
            s.on_message(B, &msg(SwapKind::Step(6), &"a".repeat(101)), 100),
            Err(Error::PayloadTooLarge)
        );
    }
}
