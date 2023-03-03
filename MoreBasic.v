Inductive bool : Type :=
    | true
    | false.

Theorem funny : forall n m : nat, False -> n + m = m + n.
Proof.
    intros. exfalso. apply H.
Qed.

Theorem plus_0_n : forall n : nat, 0 + n = n.
Proof.
    intro n.
    apply plus_O_n.
Qed.

Inductive lmao : Type :=
    | xd (u : unit).

Theorem wow : forall p q r : Prop, p -> (forall x: Prop, x -> r) -> (p -> q) -> r.
Proof.
    intros p q r pHolds rHypothesis pImpliesQ.
    apply rHypothesis with p.
    apply pHolds.
Qed.
