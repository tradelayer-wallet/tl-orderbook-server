/-!
# Swap-step relay (models `src/swap.rs`, `SwapState::on_message`)

The Rust state keeps `last_step`; a step message is `(n, sender)`. Odd steps
are the seller's, even steps the buyer's. Payload size, txid shape and trade
id checks are abstracted (they only add refusals).
-/

namespace TlOrderbook

inductive Side where
  | buyer
  | seller
  deriving DecidableEq, Repr

inductive SwapErr where
  | badEvent
  | wrongRole
  | outOfOrder
  | notParticipant
  deriving DecidableEq, Repr

/-- Rust `SwapState::sender_for`. -/
def senderFor (n : Nat) : Side := if n % 2 = 1 then .seller else .buyer

/-- Rust `on_message` for `SwapKind::Step(n)`: returns the new `last_step`. -/
def accept (last n : Nat) (who : Side) : Except SwapErr Nat :=
  if n < 1 ∨ 6 < n then .error .badEvent
  else if senderFor n ≠ who then .error .wrongRole
  else if n ≠ last + 1 then .error .outOfOrder
  else .ok n

/-- Step 5 is accepted only when step 4 was the last accepted step. -/
theorem step5_needs_step4 (last : Nat) (who : Side) (last' : Nat)
    (h : accept last 5 who = .ok last') : last = 4 := by
  unfold accept at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · omega

/-- Step 6 (settlement) is accepted only right after step 5. -/
theorem step6_needs_step5 (last : Nat) (who : Side) (last' : Nat)
    (h : accept last 6 who = .ok last') : last = 5 := by
  unfold accept at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · omega

/-- Every accepted step is exactly the successor of the previous one. -/
theorem accept_succ (last n : Nat) (who : Side) (last' : Nat)
    (h : accept last n who = .ok last') : n = last + 1 ∧ last' = n ∧ 1 ≤ n ∧ n ≤ 6 := by
  unfold accept at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · rename_i h1 h2 h3
        injection h with h
        omega

/-- A step sent by the wrong side is always refused. -/
theorem wrong_side_refused (last n : Nat) (who : Side) (hn : 1 ≤ n ∧ n ≤ 6)
    (hw : senderFor n ≠ who) : accept last n who = .error .wrongRole := by
  unfold accept
  have : ¬ (n < 1 ∨ 6 < n) := by omega
  rw [if_neg this, if_pos hw]

/-- Run a whole message sequence from `last`. -/
def run : List (Nat × Side) → Nat → Except SwapErr Nat
  | [], last => .ok last
  | (n, who) :: rest, last =>
      match accept last n who with
      | .ok last' => run rest last'
      | .error e => .error e

/-- A run only succeeds if it consumed consecutive steps, and ends after them. -/
theorem run_consecutive (msgs : List (Nat × Side)) (last last' : Nat)
    (h : run msgs last = .ok last') :
    msgs.map Prod.fst = List.range' (last + 1) msgs.length ∧ last' = last + msgs.length := by
  induction msgs generalizing last with
  | nil => simp [run] at h; simp [h]
  | cons m rest ih =>
    obtain ⟨n, who⟩ := m
    simp only [run] at h
    split at h
    · rename_i l1 hacc
      have hs := accept_succ last n who l1 hacc
      obtain ⟨h1, h2, _, _⟩ := hs
      obtain ⟨ih1, ih2⟩ := ih l1 h
      subst h2
      refine ⟨?_, ?_⟩
      · simp [List.range', h1, ih1]
      · simp; omega
    · cases h

/-- Settlement needs the full six-step conversation in order, from nothing. -/
theorem settle_needs_all_six (msgs : List (Nat × Side))
    (h : run msgs 0 = .ok 6) : msgs.map Prod.fst = [1, 2, 3, 4, 5, 6] := by
  obtain ⟨h1, h2⟩ := run_consecutive msgs 0 6 h
  have hl : msgs.length = 6 := by omega
  rw [h1, hl]
  decide

/-- `TERMINATE_TRADE`: the actor is the authenticated sender (never a payload
field), and only a participant can end the trade. -/
def terminate (buyer seller sender : Nat) : Except SwapErr Nat :=
  if sender = buyer ∨ sender = seller then .ok sender else .error .notParticipant

theorem terminate_actor_is_sender (buyer seller sender by_ : Nat)
    (h : terminate buyer seller sender = .ok by_) :
    by_ = sender ∧ (sender = buyer ∨ sender = seller) := by
  unfold terminate at h
  split at h
  · rename_i hp
    injection h with h
    exact ⟨h.symm, hp⟩
  · cases h

-- Vectors shared with the Rust tests in `src/swap.rs` and `tests/regression.rs`.
example : accept 3 5 .seller = .error .outOfOrder := rfl
example : accept 4 5 .seller = .ok 5 := rfl
example : accept 0 6 .buyer = .error .outOfOrder := rfl
example : accept 0 1 .buyer = .error .wrongRole := rfl
example : accept 5 7 .seller = .error .badEvent := rfl
example : run [(1, .seller), (2, .buyer), (3, .seller), (4, .buyer), (5, .seller), (6, .buyer)] 0
    = .ok 6 := rfl
example : terminate 1 2 3 = .error .notParticipant := rfl

end TlOrderbook
