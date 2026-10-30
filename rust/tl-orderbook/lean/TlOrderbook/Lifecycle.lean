/-!
# Order lifecycle (models `src/lifecycle.rs`)

`State` is `OrderState`, `allowed` is `edge_allowed`, `transition` is
`Order::transition` (without the event log, which is a pure side effect).
-/

namespace TlOrderbook

inductive State where
  | new
  | opn        -- `Open`
  | locked     -- `LockedInSwap`
  | settled
  | cancelled
  deriving DecidableEq, Repr

/-- The complete set of allowed edges (Rust `edge_allowed`). -/
def allowed : State → State → Bool
  | .new, .opn => true
  | .new, .locked => true
  | .new, .cancelled => true
  | .opn, .locked => true
  | .opn, .cancelled => true
  | .locked, .opn => true
  | .locked, .settled => true
  | .locked, .cancelled => true
  | _, _ => false

/-- Rust `is_terminal`. -/
def terminal : State → Bool
  | .settled => true
  | .cancelled => true
  | _ => false

/-- Rust `Order::transition`: move along an allowed edge or refuse. -/
def transition (s t : State) : Except Unit State :=
  if allowed s t then .ok t else .error ()

/-- Terminal states have no outgoing edge. -/
theorem terminal_no_exit (s t : State) (h : terminal s = true) : allowed s t = false := by
  cases s <;> cases t <;> simp_all [terminal, allowed]

/-- An order becomes `Settled` only out of a swap lock. -/
theorem settled_only_from_locked (s : State) (h : allowed s .settled = true) : s = .locked := by
  cases s <;> simp_all [allowed]

/-- Nothing ever returns to `New`. -/
theorem never_reenter_new (s : State) : allowed s .new = false := by
  cases s <;> simp [allowed]

/-- A taker or maker only reaches `Cancelled` from a live state. -/
theorem cancelled_only_from_live (s : State) (h : allowed s .cancelled = true) :
    terminal s = false := by
  cases s <;> simp_all [allowed, terminal]

/-- An unsettled swap can hand a maker order back: the unlock edge exists. -/
theorem unlock_edge : allowed .locked .opn = true := rfl

/-- `transition` succeeds exactly along allowed edges, and lands on the target. -/
theorem transition_sound (s t u : State) (h : transition s t = .ok u) :
    allowed s t = true ∧ u = t := by
  unfold transition at h
  split at h
  · simp_all
  · cases h

theorem transition_complete (s t : State) (h : allowed s t = true) :
    transition s t = .ok t := by
  simp [transition, h]

def states : List State := [.new, .opn, .locked, .settled, .cancelled]

def edges : List (State × State) :=
  states.flatMap fun a => states.filterMap fun b => if allowed a b then some (a, b) else none

/-- Same count as the Rust test `exactly_eight_edges`. -/
example : edges.length = 8 := by decide

example : allowed .locked .settled = true := by decide
example : allowed .opn .settled = false := by decide
example : transition .settled .opn = .error () := rfl

end TlOrderbook
