/-!
# Matching (models `src/book.rs`: `Orderbook::find_match` and `build_trade`)

`Order` keeps the fields matching reads. Prices and amounts are the Rust raw
integers (1e-6 units), so everything here is `Nat`. Spot crossing is modelled
with `desired`/`sale`; futures orders are the same shape with one contract id
and are not modelled separately.

* `eligible t o`  = the closure `crosses` in `find_match`.
* `pickBest`      = `min_by_key` (first minimum): the lowest price for a buy
  taker, the highest for a sell taker, ties to the earlier order.
* `findMatch`     = `find_match` including the self-match errors.
* `build`         = `build_trade`'s amounts, with the dust rule.
-/

namespace TlOrderbook

inductive Action where
  | buy
  | sell
  deriving DecidableEq, Repr

def Action.opp : Action → Action
  | .buy => .sell
  | .sell => .buy

structure Order where
  id : Nat
  owner : Nat
  addr : Nat
  action : Action
  desired : Nat
  sale : Nat
  price : Nat
  amount : Nat
  locked : Bool
  deriving DecidableEq, Repr

/-- Price acceptable to the taker: buy takes `o.price ≤ t.price`, sell `o.price ≥ t.price`. -/
def priceOk (t o : Order) : Bool :=
  match t.action with
  | .buy => decide (o.price ≤ t.price)
  | .sell => decide (t.price ≤ o.price)

/-- Candidate filter of `find_match`. -/
def eligible (t o : Order) : Bool :=
  o.desired == t.sale && o.sale == t.desired && o.action == t.action.opp
    && priceOk t o && !o.locked

/-- `a` is strictly preferable to `b` for a taker acting as `ta`. -/
def better (ta : Action) (a b : Order) : Bool :=
  match ta with
  | .buy => decide (a.price < b.price)
  | .sell => decide (b.price < a.price)

/-- Fold step of `min_by_key`: keep the incumbent unless the challenger is strictly better. -/
def bestFrom (t : Order) (b : Order) : List Order → Order
  | [] => b
  | o :: os =>
      if eligible t o && better t.action o b then bestFrom t o os else bestFrom t b os

/-- First eligible order, improved only by strictly better later ones. -/
def pickBest (t : Order) : List Order → Option Order
  | [] => none
  | o :: os => if eligible t o then some (bestFrom t o os) else pickBest t os

theorem better_irrefl (a : Action) (x : Order) : better a x x = false := by
  cases a <;> simp [better]

theorem better_trans (a : Action) (x y z : Order) (h1 : better a x y = true)
    (h2 : better a y z = true) : better a x z = true := by
  cases a <;> simp [better] at * <;> omega

theorem better_asymm (a : Action) (x y : Order) (h : better a x y = true) :
    better a y x = false := by
  cases a <;> simp [better] at * <;> omega

/-! ### `bestFrom` -/

theorem bf_mem (t b : Order) (os : List Order) : bestFrom t b os = b ∨ bestFrom t b os ∈ os := by
  induction os generalizing b with
  | nil => simp [bestFrom]
  | cons o os ih =>
    simp only [bestFrom]
    split
    · rcases ih o with h | h
      · right; simp [h]
      · right; simp [h]
    · rcases ih b with h | h
      · left; exact h
      · right; simp [h]

theorem bf_elig (t b : Order) (os : List Order) (hb : eligible t b = true) :
    eligible t (bestFrom t b os) = true := by
  induction os generalizing b with
  | nil => simpa [bestFrom] using hb
  | cons o os ih =>
    simp only [bestFrom]
    split
    · rename_i hc
      simp only [Bool.and_eq_true] at hc
      exact ih o hc.1
    · exact ih b hb

theorem better_skip (ta : Action) (x b r : Order) (hnb : better ta x b = false)
    (hbr : better ta b r = false) : better ta x r = false := by
  cases ta <;> simp only [better, decide_eq_true_eq, decide_eq_false_iff_not] at * <;> omega

theorem better_flip (ta : Action) (x p r : Order) (hnb : better ta x p = false)
    (hrp : better ta r p = true) : better ta r x = true := by
  cases ta <;> simp only [better, decide_eq_true_eq, decide_eq_false_iff_not] at * <;> omega

/-- Nothing eligible in `b :: os` is strictly better than the chosen order. -/
theorem bf_best (t b : Order) (os : List Order) (hb : eligible t b = true) :
    ∀ x ∈ b :: os, eligible t x = true → better t.action x (bestFrom t b os) = false := by
  induction os generalizing b with
  | nil =>
    intro x hx hxe
    have hxb : x = b := by simpa using hx
    rw [hxb]
    simpa [bestFrom] using better_irrefl t.action b
  | cons o os ih =>
    intro x hx hxe
    simp only [bestFrom]
    split
    · rename_i hc
      simp only [Bool.and_eq_true] at hc
      obtain ⟨hoe, hob⟩ := hc
      have ih' := ih o hoe
      rcases List.mem_cons.mp hx with hxb | hx'
      · -- x = b: if b beat the result, o would too (o beats b)
        rw [hxb]
        have h1 := ih' o (by simp) hoe
        cases hcon : better t.action b (bestFrom t o os)
        · rfl
        · have := better_trans _ _ _ _ hob hcon
          rw [h1] at this
          cases this
      · exact ih' x hx' hxe
    · rename_i hc
      have ih' := ih b hb
      rcases List.mem_cons.mp hx with hxb | hx'
      · rw [hxb]
        exact ih' b (by simp) hb
      · rcases List.mem_cons.mp hx' with hxo | hx''
        · -- x = o, skipped because it was not strictly better than b
          rw [hxo] at hxe ⊢
          have hnb : better t.action o b = false := by
            cases hb' : better t.action o b
            · rfl
            · exact absurd (by simp [hxe, hb']) hc
          exact better_skip _ _ _ _ hnb (ih' b (by simp) hb)
        · exact ih' x (by simp [hx'']) hxe

/-- Time priority: every *earlier* eligible order is strictly worse than the chosen one. -/
theorem bf_first (t b : Order) (os : List Order) (hb : eligible t b = true) :
    ∃ pre post, b :: os = pre ++ bestFrom t b os :: post ∧
      ∀ x ∈ pre, eligible t x = true → better t.action (bestFrom t b os) x = true := by
  induction os generalizing b with
  | nil => exact ⟨[], [], by simp [bestFrom], by simp⟩
  | cons o os ih =>
    simp only [bestFrom]
    split
    · rename_i hc
      simp only [Bool.and_eq_true] at hc
      obtain ⟨hoe, hob⟩ := hc
      obtain ⟨pre, post, hdec, hpre⟩ := ih o hoe
      refine ⟨b :: pre, post, by rw [List.cons_append, ← hdec], ?_⟩
      intro x hx hxe
      rcases List.mem_cons.mp hx with hxb | hx'
      · rw [hxb]
        cases pre with
        | nil =>
          simp only [List.nil_append, List.cons.injEq] at hdec
          rw [← hdec.1]
          exact hob
        | cons p pre' =>
          simp only [List.cons_append, List.cons.injEq] at hdec
          have hp : o = p := hdec.1
          have := hpre p (by simp) (by rw [← hp]; exact hoe)
          rw [← hp] at this
          exact better_trans _ _ _ _ this hob
      · exact hpre x hx' hxe
    · rename_i hc
      obtain ⟨pre, post, hdec, hpre⟩ := ih b hb
      cases pre with
      | nil =>
        simp only [List.nil_append, List.cons.injEq] at hdec
        refine ⟨[], o :: os, ?_, by simp⟩
        rw [List.nil_append, ← hdec.1, hdec.2]
      | cons p pre' =>
        simp only [List.cons_append, List.cons.injEq] at hdec
        obtain ⟨hpb, htail⟩ := hdec
        subst hpb
        refine ⟨b :: o :: pre', post, congrArg (fun l => b :: o :: l) htail, ?_⟩
        intro x hx hxe
        rcases List.mem_cons.mp hx with hxp | hx'
        · rw [hxp]
          exact hpre b (by simp) hb
        · rcases List.mem_cons.mp hx' with hxo | hx''
          · -- x = o is eligible but not strictly better than p; r is strictly better than p
            rw [hxo] at hxe ⊢
            have hrp := hpre b (by simp) hb
            have hnb : better t.action o b = false := by
              cases hb' : better t.action o b
              · rfl
              · exact absurd (by simp [hxe, hb']) hc
            exact better_flip _ _ _ _ hnb hrp
          · exact hpre x (by simp [hx'']) hxe

/-! ### `pickBest` -/

theorem pick_sound (t : Order) (os : List Order) (m : Order) (h : pickBest t os = some m) :
    m ∈ os ∧ eligible t m = true := by
  induction os with
  | nil => simp [pickBest] at h
  | cons o os ih =>
    simp only [pickBest] at h
    split at h
    · rename_i he
      injection h with h
      subst h
      refine ⟨?_, bf_elig t o os he⟩
      rcases bf_mem t o os with h1 | h1
      · simp [h1]
      · simp [h1]
    · obtain ⟨h1, h2⟩ := ih h
      exact ⟨by simp [h1], h2⟩

/-- Price priority: no eligible order is strictly better than the chosen one. -/
theorem pick_best (t : Order) (os : List Order) (m : Order) (h : pickBest t os = some m) :
    ∀ x ∈ os, eligible t x = true → better t.action x m = false := by
  induction os with
  | nil => simp [pickBest] at h
  | cons o os ih =>
    simp only [pickBest] at h
    split at h
    · rename_i he
      injection h with h
      subst h
      exact bf_best t o os he
    · intro x hx hxe
      rcases List.mem_cons.mp hx with rfl | hx'
      · simp_all
      · exact ih h x hx' hxe

/-- Time priority: the chosen order has only strictly worse eligible orders before it. -/
theorem pick_first (t : Order) (os : List Order) (m : Order) (h : pickBest t os = some m) :
    ∃ pre post, os = pre ++ m :: post ∧
      ∀ x ∈ pre, eligible t x = true → better t.action m x = true := by
  induction os with
  | nil => simp [pickBest] at h
  | cons o os ih =>
    simp only [pickBest] at h
    split at h
    · rename_i he
      injection h with h
      subst h
      exact bf_first t o os he
    · obtain ⟨pre, post, hd, hp⟩ := ih h
      refine ⟨o :: pre, post, by simp [hd], ?_⟩
      intro x hx hxe
      rcases List.mem_cons.mp hx with rfl | hx'
      · simp_all
      · exact hp x hx' hxe

theorem pick_none (t : Order) (os : List Order) (h : pickBest t os = none) :
    ∀ x ∈ os, eligible t x = false := by
  induction os with
  | nil => simp
  | cons o os ih =>
    simp only [pickBest] at h
    split at h
    · cases h
    · rename_i he
      intro x hx
      rcases List.mem_cons.mp hx with rfl | hx'
      · simpa using he
      · exact ih h x hx'

/-- The chosen order's price is never worse than the taker's limit, so a fill
at the maker's price is within the taker's limit. -/
theorem fill_price_within_limit (t m : Order) (h : eligible t m = true) :
    match t.action with
    | .buy => m.price ≤ t.price
    | .sell => t.price ≤ m.price := by
  unfold eligible priceOk at h
  cases hta : t.action <;> simp_all

/-! ### self-match and `find_match` -/

inductive MatchErr where
  | sameAccount
  | sameAddress
  deriving DecidableEq, Repr

/-- Rust `find_match`: the best candidate, refused if it is the taker's own. -/
def findMatch (t : Order) (os : List Order) : Except MatchErr (Option Order) :=
  match pickBest t os with
  | none => .ok none
  | some m =>
      if m.owner = t.owner then .error .sameAccount
      else if m.addr = t.addr then .error .sameAddress
      else .ok (some m)

/-- A returned match is never the taker's own session or address. -/
theorem no_self_match (t : Order) (os : List Order) (m : Order)
    (h : findMatch t os = .ok (some m)) : m.owner ≠ t.owner ∧ m.addr ≠ t.addr := by
  unfold findMatch at h
  split at h
  · cases h
  · rename_i m' hm'
    split at h
    · cases h
    · rename_i h1
      split at h
      · cases h
      · rename_i h2
        injection h with h
        injection h with h
        subst h
        exact ⟨h1, h2⟩

/-- A returned match is a resting, unlocked, crossing order within the limit. -/
theorem find_match_sound (t : Order) (os : List Order) (m : Order)
    (h : findMatch t os = .ok (some m)) :
    m ∈ os ∧ eligible t m = true ∧ m.locked = false := by
  unfold findMatch at h
  split at h
  · cases h
  · rename_i m' hm'
    split at h
    · cases h
    · split at h
      · cases h
      · injection h with h
        injection h with h
        subst h
        obtain ⟨h1, h2⟩ := pick_sound t os m' hm'
        refine ⟨h1, h2, ?_⟩
        simp [eligible] at h2
        exact h2.2

/-! ### Fill amounts and dust -/

/-- Rust `split_dust`: a remainder below `minA` is dropped and accounted as dust. -/
def splitDust (rem minA : Nat) : Nat × Nat :=
  if rem = 0 ∨ minA ≤ rem then (rem, 0) else (0, rem)

structure Built where
  fill : Nat
  takerLive : Nat
  takerDust : Nat
  makerLive : Nat
  makerDust : Nat
  deriving DecidableEq, Repr

/-- Rust `build_trade` (amounts only). -/
def build (tAmt mAmt minA : Nat) : Built :=
  let f := min tAmt mAmt
  let t := splitDust (tAmt - f) minA
  let m := splitDust (mAmt - f) minA
  { fill := f, takerLive := t.1, takerDust := t.2, makerLive := m.1, makerDust := m.2 }

theorem split_dust_sum (rem minA : Nat) :
    (splitDust rem minA).1 + (splitDust rem minA).2 = rem := by
  unfold splitDust
  split <;> simp

/-- Conservation, taker side: fill + live remainder + dust = original amount. -/
theorem conserve_taker (tAmt mAmt minA : Nat) :
    (build tAmt mAmt minA).fill + (build tAmt mAmt minA).takerLive
      + (build tAmt mAmt minA).takerDust = tAmt := by
  have := split_dust_sum (tAmt - min tAmt mAmt) minA
  simp only [build]
  omega

/-- Conservation, maker side. -/
theorem conserve_maker (tAmt mAmt minA : Nat) :
    (build tAmt mAmt minA).fill + (build tAmt mAmt minA).makerLive
      + (build tAmt mAmt minA).makerDust = mAmt := by
  have := split_dust_sum (mAmt - min tAmt mAmt) minA
  simp only [build]
  omega

/-- Only one side keeps a live remainder (the smaller order is consumed). -/
theorem one_live_side (tAmt mAmt minA : Nat) :
    (build tAmt mAmt minA).takerLive = 0 ∨ (build tAmt mAmt minA).makerLive = 0 := by
  simp only [build, splitDust]
  by_cases h : tAmt ≤ mAmt
  · left
    have : tAmt - min tAmt mAmt = 0 := by omega
    simp [this]
  · right
    have : mAmt - min tAmt mAmt = 0 := by omega
    simp [this]

theorem fill_le (tAmt mAmt minA : Nat) :
    (build tAmt mAmt minA).fill ≤ tAmt ∧ (build tAmt mAmt minA).fill ≤ mAmt := by
  simp only [build]
  omega

theorem fill_pos (tAmt mAmt minA : Nat) (h1 : 0 < tAmt) (h2 : 0 < mAmt) :
    0 < (build tAmt mAmt minA).fill := by
  simp only [build]
  omega

/-- With a minimum of 1 raw unit (the legacy behaviour) there is never any dust. -/
theorem no_dust_at_unit_minimum (tAmt mAmt : Nat) :
    (build tAmt mAmt 1).takerDust = 0 ∧ (build tAmt mAmt 1).makerDust = 0 := by
  simp only [build, splitDust]
  constructor <;> split <;> simp <;> omega

/-! ### Vectors shared with the Rust tests -/

def mkO (id owner addr : Nat) (a : Action) (d s p amt : Nat) (lk : Bool := false) : Order :=
  { id, owner, addr, action := a, desired := d, sale := s, price := p, amount := amt, locked := lk }

-- parity case `price_priority_buy`: sells at 2.80, 2.40, 2.60 vs a buy at 3.00 -> the 2.40 order (id 2)
def ppBook : List Order :=
  [mkO 1 1 1 .sell 2 1 2800000 1000000, mkO 2 3 3 .sell 2 1 2400000 1000000,
   mkO 3 4 4 .sell 2 1 2600000 1000000]
def ppTaker : Order := mkO 9 2 2 .buy 1 2 3000000 1000000
example : (pickBest ppTaker ppBook).map (·.id) = some 2 := by decide

-- parity case `price_priority_sell`: buys at 2.80, 2.40, 2.90 vs a sell at 2.00 -> the 2.90 order (id 3 in the book, sock 4)
example : (pickBest (mkO 9 2 2 .sell 2 1 2000000 1000000)
    [mkO 1 1 1 .buy 1 2 2800000 1000000, mkO 2 3 3 .buy 1 2 2400000 1000000,
     mkO 3 4 4 .buy 1 2 2900000 1000000]).map (·.id) = some 3 := by decide

-- parity case `time_priority_tie`: equal prices -> the earlier order (id 1)
example : (pickBest (mkO 9 2 2 .buy 1 2 2500000 1000000)
    [mkO 1 3 3 .sell 2 1 2500000 1000000, mkO 2 4 4 .sell 2 1 2500000 1000000]).map (·.id) = some 1 := by
  decide

-- parity case `locked_skipped`: the cheaper locked order is ignored
example : (pickBest (mkO 9 2 2 .buy 1 2 3000000 1000000)
    [mkO 1 1 1 .sell 2 1 2400000 1000000 true, mkO 2 3 3 .sell 2 1 2600000 1000000]).map (·.id)
    = some 2 := by decide

-- parity case `same_session_errors`: the best order belongs to the taker's session
example : findMatch (mkO 9 2 2 .buy 1 2 3000000 1000000)
    [mkO 1 2 1 .sell 2 1 2400000 1000000, mkO 2 3 3 .sell 2 1 2600000 1000000]
    = .error .sameAccount := rfl

-- parity case `same_address_errors`
example : findMatch (mkO 9 2 7 .buy 1 2 3000000 1000000) [mkO 1 1 7 .sell 2 1 2400000 1000000]
    = .error .sameAddress := rfl

-- parity case `taker_partial_then_rests` (taker 2.5 vs maker 1.0, no dust rule): 1.5 left for the taker
example : build 2500000 1000000 1 = ⟨1000000, 1500000, 0, 0, 0⟩ := by decide
-- Rust test `d2_dust_remainder_is_dropped_and_accounted` (min 0.001): maker 1.0005, taker 1
example : build 1000000 1000500 1000 = ⟨1000000, 0, 0, 0, 500⟩ := by decide
-- Rust test `d2_remainder_exactly_at_minimum_stays`
example : build 1000000 1001000 1000 = ⟨1000000, 0, 0, 1000, 0⟩ := by decide

end TlOrderbook
