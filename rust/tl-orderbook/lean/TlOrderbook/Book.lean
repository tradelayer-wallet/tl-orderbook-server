import TlOrderbook.Match

/-!
# Book operations (models `Orderbook::submit` placement, `cancel`, `abort`)

* `place`   = the placement branch of `submit` with the `max_side_depth` guard.
* `cancel`  = `Orderbook::cancel`: only the owner, never a locked order.
* `unlock`  = `Orderbook::abort` on the maker: flips `locked` and nothing else.
-/

namespace TlOrderbook

/-- Resting orders on one side. -/
def sideCount (a : Action) (os : List Order) : Nat := os.countP (fun o => o.action == a)

def Bounded (cap : Nat) (os : List Order) : Prop := ∀ a, sideCount a os ≤ cap

/-- Placement with the depth guard (Rust: `Error::BookFull` otherwise). -/
def place (cap : Nat) (os : List Order) (o : Order) : Option (List Order) :=
  if sideCount o.action os < cap then some (os ++ [o]) else none

theorem place_preserves_bound (cap : Nat) (os os' : List Order) (o : Order)
    (hb : Bounded cap os) (h : place cap os o = some os') : Bounded cap os' := by
  unfold place at h
  split at h
  · rename_i hlt
    injection h with h
    subst h
    intro a
    have := hb a
    simp only [sideCount, List.countP_append] at *
    cases hoa : (o.action == a)
    · simp [hoa]; omega
    · have : o.action = a := by simpa using hoa
      subst this
      simp
      omega
  · cases h

/-- The guard is what bounds depth: a full side refuses placement. -/
theorem place_refused_when_full (cap : Nat) (os : List Order) (o : Order)
    (h : cap ≤ sideCount o.action os) : place cap os o = none := by
  unfold place
  have : ¬ sideCount o.action os < cap := by omega
  simp [this]

inductive CancelErr where
  | notFound
  | notAuthorized
  | locked
  deriving DecidableEq, Repr

/-- Rust `Orderbook::cancel` (check order: exists, owner, not locked). -/
def cancel (os : List Order) (requester id : Nat) : Except CancelErr (List Order) :=
  match os.find? (fun o => o.id == id) with
  | none => .error .notFound
  | some o =>
      if o.owner ≠ requester then .error .notAuthorized
      else if o.locked then .error .locked
      else .ok (os.filter (fun x => x.id != id))

/-- Cancellation succeeds only for the owning session, on an unlocked order. -/
theorem cancel_authorized (os os' : List Order) (requester id : Nat)
    (h : cancel os requester id = .ok os') :
    ∃ o ∈ os, o.id = id ∧ o.owner = requester ∧ o.locked = false := by
  unfold cancel at h
  split at h
  · cases h
  · rename_i o ho
    split at h
    · cases h
    · rename_i h1
      split at h
      · cases h
      · rename_i h2
        refine ⟨o, List.mem_of_find?_eq_some ho, ?_, ?_, ?_⟩
        · have := List.find?_some ho
          simpa using this
        · simpa using h1
        · simpa using h2

/-- Cancellation never touches other orders and never grows the book. -/
theorem cancel_only_removes (os os' : List Order) (requester id : Nat)
    (h : cancel os requester id = .ok os') :
    (∀ x ∈ os', x ∈ os ∧ x.id ≠ id) ∧ os'.length ≤ os.length := by
  unfold cancel at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · injection h with h
        subst h
        refine ⟨?_, List.length_filter_le _ _⟩
        intro x hx
        rw [List.mem_filter] at hx
        exact ⟨hx.1, by simpa using hx.2⟩

/-- Cancellation preserves the depth bound. -/
theorem cancel_preserves_bound (cap : Nat) (os os' : List Order) (requester id : Nat)
    (hb : Bounded cap os) (h : cancel os requester id = .ok os') : Bounded cap os' := by
  unfold cancel at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · injection h with h
        subst h
        intro a
        exact Nat.le_trans (List.Sublist.countP_le List.filter_sublist) (hb a)

/-- Rust `Orderbook::abort` on the maker: clear the lock, change nothing else. -/
def unlock (os : List Order) (id : Nat) : List Order :=
  os.map fun o => if o.id = id then { o with locked := false } else o

/-- An unsettled swap never removes an order: same ids, same owners, same length. -/
theorem unlock_keeps_orders (os : List Order) (id : Nat) :
    (unlock os id).map (·.id) = os.map (·.id) ∧
    (unlock os id).map (·.owner) = os.map (·.owner) ∧
    (unlock os id).length = os.length := by
  unfold unlock
  refine ⟨?_, ?_, by simp⟩
  · simp only [List.map_map]
    apply List.map_congr_left
    intro o _
    by_cases h : o.id = id <;> simp [h]
  · simp only [List.map_map]
    apply List.map_congr_left
    intro o _
    by_cases h : o.id = id <;> simp [h]

theorem unlock_never_removes (os : List Order) (id : Nat) (o : Order) (ho : o ∈ os) :
    ∃ o' ∈ unlock os id, o'.id = o.id ∧ o'.owner = o.owner := by
  unfold unlock
  refine ⟨if o.id = id then { o with locked := false } else o, ?_, ?_, ?_⟩
  · exact List.mem_map.mpr ⟨o, ho, rfl⟩
  · by_cases h : o.id = id <;> simp [h]
  · by_cases h : o.id = id <;> simp [h]

/-- Unlocking keeps the depth bound (actions are untouched). -/
theorem unlock_preserves_bound (cap : Nat) (os : List Order) (id : Nat) (hb : Bounded cap os) :
    Bounded cap (unlock os id) := by
  intro a
  have h := hb a
  unfold sideCount unlock at *
  rw [List.countP_map]
  have : ((fun o : Order => o.action == a) ∘ fun o : Order =>
      if o.id = id then { o with locked := false } else o) = fun o : Order => o.action == a := by
    funext o
    by_cases h : o.id = id <;> simp [h]
  rw [this]
  exact h

/-- Only the targeted order changes, and only its lock bit. -/
theorem unlock_only_clears_lock (os : List Order) (id : Nat) (x : Order) (hx : x ∈ unlock os id) :
    x ∈ os ∨ ∃ o ∈ os, o.id = id ∧ x = { o with locked := false } := by
  unfold unlock at hx
  obtain ⟨o, ho, rfl⟩ := List.mem_map.mp hx
  by_cases h : o.id = id
  · right; exact ⟨o, ho, h, by simp [h]⟩
  · left; simpa [h] using ho

-- Vectors shared with the Rust regression tests.
example : cancel [mkO 1 5 5 .sell 2 1 100 100] 6 1 = .error .notAuthorized := rfl
example : cancel [mkO 1 5 5 .sell 2 1 100 100 true] 5 1 = .error .locked := rfl
example : cancel [mkO 1 5 5 .sell 2 1 100 100] 5 2 = .error .notFound := rfl
example : (cancel [mkO 1 5 5 .sell 2 1 100 100] 5 1).toOption = some [] := rfl
example : place 2 [mkO 1 1 1 .sell 2 1 9 1, mkO 2 2 2 .sell 2 1 9 1] (mkO 3 3 3 .sell 2 1 9 1) = none := by
  decide
example : (place 2 [mkO 1 1 1 .sell 2 1 9 1, mkO 2 2 2 .sell 2 1 9 1] (mkO 3 3 3 .buy 1 2 1 1)).isSome
    = true := by decide

end TlOrderbook
