//! Order lifecycle state machine.
//!
//! ```text
//!            +--------------------------------------+
//!            |                                      v
//!   New --> Open --> LockedInSwap --> Settled     Cancelled
//!    |        ^           |   |                      ^
//!    |        +-----------+   +----------------------+
//!    |       (unlock / partial fill remainder)  (taker's swap failed)
//!    +--> LockedInSwap (taker matched immediately)
//!    +--> Cancelled    (rejected / dropped crossing batch order)
//! ```
//!
//! `Settled` and `Cancelled` are terminal. An unsettled swap returns a maker
//! order to `Open` (never to `Cancelled`); only the owner's explicit close
//! (or disconnect) moves `Open -> Cancelled`.

use crate::error::Error;
use crate::types::{Order, OrderId, OrderState, SessionId};

/// The complete set of allowed edges.
pub fn edge_allowed(from: OrderState, to: OrderState) -> bool {
    use OrderState::*;
    matches!(
        (from, to),
        (New, Open)
            | (New, LockedInSwap)
            | (New, Cancelled)
            | (Open, LockedInSwap)
            | (Open, Cancelled)
            | (LockedInSwap, Open)
            | (LockedInSwap, Settled)
            | (LockedInSwap, Cancelled)
    )
}

/// True for states with no outgoing edge.
pub fn is_terminal(s: OrderState) -> bool {
    matches!(s, OrderState::Settled | OrderState::Cancelled)
}

/// Why a transition happened (external order-event capture).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Rested on the book.
    Placed,
    /// Crossed the book; a swap was opened.
    Matched,
    /// Swap settled and the order is completely filled.
    Filled,
    /// Swap settled; a remainder stays live.
    PartialFill,
    /// Swap settled; the remainder was below the minimum size and dropped.
    FilledDust,
    /// Swap ended without settlement (terminated by a participant).
    SwapTerminated,
    /// Swap ended without settlement (timeout).
    SwapTimedOut,
    /// Owner sent `close-order`.
    OwnerCancelled,
    /// Owner's session disconnected.
    Disconnected,
    /// Crossing order inside a `many-orders` batch (legacy: silently dropped).
    BatchCrossing,
}

/// One recorded lifecycle edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleEvent {
    pub order: OrderId,
    pub session: SessionId,
    pub from: OrderState,
    pub to: OrderState,
    pub reason: Reason,
    pub at: u64,
}

impl Order {
    /// Move along an allowed edge, recording the event. Refuses anything else.
    pub fn transition(
        &mut self,
        to: OrderState,
        reason: Reason,
        at: u64,
        events: &mut Vec<LifecycleEvent>,
    ) -> Result<(), Error> {
        if !edge_allowed(self.state, to) {
            return Err(Error::IllegalTransition);
        }
        events.push(LifecycleEvent {
            order: self.id,
            session: self.session,
            from: self.state,
            to,
            reason,
            at,
        });
        self.state = to;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use OrderState::*;

    #[test]
    fn terminal_states_have_no_outgoing_edges() {
        for to in [New, Open, LockedInSwap, Settled, Cancelled] {
            assert!(!edge_allowed(Settled, to));
            assert!(!edge_allowed(Cancelled, to));
        }
    }

    #[test]
    fn settled_only_from_locked() {
        for from in [New, Open, Settled, Cancelled] {
            assert!(!edge_allowed(from, Settled));
        }
        assert!(edge_allowed(LockedInSwap, Settled));
    }

    #[test]
    fn nothing_returns_to_new() {
        for from in [New, Open, LockedInSwap, Settled, Cancelled] {
            assert!(!edge_allowed(from, New));
        }
    }

    #[test]
    fn exactly_eight_edges() {
        let all = [New, Open, LockedInSwap, Settled, Cancelled];
        let n = all
            .iter()
            .flat_map(|a| all.iter().map(move |b| (*a, *b)))
            .filter(|(a, b)| edge_allowed(*a, *b))
            .count();
        assert_eq!(n, 8);
    }
}
