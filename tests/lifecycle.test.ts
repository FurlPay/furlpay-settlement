import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, releaseDecision, timings, type PaymentState } from "../src/lifecycle.js";
import { planSettlement } from "../src/tiers.js";

// ---------------------------------------------------------------------------
// The release decision.
//
// One question — may the merchant hand over the goods? — and the tests here
// are almost entirely about the ways it must answer "no". Being wrong toward
// "no" costs a support ticket. Being wrong toward "yes" costs the payment.
//
// The state that carries the weight is `confirmed`: on-chain, visible in an
// explorer, and NOT yet irreversible. Everything the package exists for lives
// in how that one status is answered for different amounts and chains.
// ---------------------------------------------------------------------------

function state(over: Partial<PaymentState> = {}): PaymentState {
  return {
    status: "confirmed",
    chain: "solana",
    amountUsd: 25,
    txSignature: "sig_1",
    ...over,
  };
}

test("a small confirmed payment is releasable", () => {
  const s = state({ amountUsd: 4.5 });
  const plan = planSettlement({ amountUsd: s.amountUsd, chain: s.chain });
  const decision = releaseDecision(s, plan);
  assert.equal(decision.releasable, true);
  assert.equal(decision.waitingFor, null);
});

test("a large confirmed payment is NOT releasable — the core case", () => {
  // Confirmed is not final. A merchant releasing a $5,000 order here has
  // accepted a re-org risk they were never shown.
  const s = state({ amountUsd: 5_000 });
  const plan = planSettlement({ amountUsd: s.amountUsd, chain: s.chain });
  const decision = releaseDecision(s, plan);
  assert.equal(decision.releasable, false);
  assert.equal(decision.waitingFor, "finality");
  assert.match(decision.message, /not yet irreversible/i);
  // It resolves by waiting, so no intervention is needed.
  assert.equal(decision.needsIntervention, false);
});

test("the same large payment IS releasable once finalized", () => {
  const s = state({ amountUsd: 5_000, status: "finalized" });
  const plan = planSettlement({ amountUsd: s.amountUsd, chain: s.chain });
  assert.equal(releaseDecision(s, plan).releasable, true);
});

test("Alpenglow makes the wait short, not absent", () => {
  // The upgrade changes the duration. It does not change the rule that a large
  // payment waits for finality — which is why the tier survives it untouched.
  const s = state({ amountUsd: 5_000 });
  const plan = planSettlement({
    amountUsd: s.amountUsd,
    chain: "solana",
    observation: { votorCertificateSeen: true },
  });
  const decision = releaseDecision(s, plan);
  assert.equal(decision.releasable, false, "confirmed is still not finalized");
  assert.equal(plan.expectedWaitMs, 150, "but the wait is now 150ms, not 12.8s");
});

test("a large payment on an optimistic rollup needs intervention, not patience", () => {
  // Arbitrum is the primary rail. Waiting here never resolves, so the decision
  // has to say so rather than leaving a merchant polling forever.
  const s = state({ amountUsd: 5_000, chain: "arbitrum" });
  const plan = planSettlement({ amountUsd: s.amountUsd, chain: "arbitrum" });
  const decision = releaseDecision(s, plan);
  assert.equal(decision.releasable, false);
  assert.equal(decision.needsIntervention, true);
  assert.match(decision.message, /no bounded finality/i);
});

test("pre-chain states are never releasable", () => {
  for (const status of ["created", "submitted"] as const) {
    const s = state({ status, amountUsd: 1 });
    const plan = planSettlement({ amountUsd: 1, chain: s.chain });
    const decision = releaseDecision(s, plan);
    assert.equal(decision.releasable, false, `${status} must not release`);
  }
});

test("terminal failures say the money did not move", () => {
  // The thing a merchant actually needs to know, and the thing a status code
  // does not tell them.
  for (const status of ["failed", "expired"] as const) {
    const s = state({ status });
    const plan = planSettlement({ amountUsd: s.amountUsd, chain: s.chain });
    const decision = releaseDecision(s, plan);
    assert.equal(decision.releasable, false);
    assert.equal(decision.needsIntervention, true);
    assert.match(decision.message, /nothing was transferred/i);
  }
});

test("an unrecognised status fails closed", () => {
  // Data from outside the type system — a stale row, a bad migration. The safe
  // reading of a bug is "do not release".
  const s = { ...state(), status: "wat" as PaymentState["status"] };
  const plan = planSettlement({ amountUsd: 25, chain: "solana" });
  const decision = releaseDecision(s, plan);
  assert.equal(decision.releasable, false);
  assert.equal(decision.needsIntervention, true);
});

test("every decision carries a message a human can act on", () => {
  for (const status of ["created", "submitted", "confirmed", "finalized", "failed", "expired"] as const) {
    const s = state({ status, amountUsd: 5_000 });
    const plan = planSettlement({ amountUsd: s.amountUsd, chain: s.chain });
    const decision = releaseDecision(s, plan);
    assert.ok(decision.message.length > 15, `${status} needs a real message`);
    // Never a raw status code or error string.
    assert.doesNotMatch(decision.message, /^[A-Z_]+$/, `${status} leaked a status code`);
  }
});

// ── state machine ─────────────────────────────────────────────────────────

test("payments never move backwards", () => {
  assert.equal(canTransition("finalized", "confirmed"), false);
  assert.equal(canTransition("confirmed", "submitted"), false);
  assert.equal(canTransition("submitted", "created"), false);
});

test("terminal states are terminal", () => {
  for (const terminal of ["finalized", "failed", "expired"] as const) {
    for (const to of ["created", "submitted", "confirmed", "finalized"] as const) {
      assert.equal(canTransition(terminal, to), false, `${terminal} → ${to} must be refused`);
    }
  }
});

test("a confirmed payment may still fail", () => {
  // The transition that proves `confirmed` is not `finalized`: a confirmed
  // transaction can be dropped by a re-org before finality. If the machine
  // forbade this, the state would be a lie.
  assert.equal(canTransition("confirmed", "failed"), true);
  assert.equal(canTransition("confirmed", "finalized"), true);
});

test("the happy path is walkable end to end", () => {
  assert.equal(canTransition("created", "submitted"), true);
  assert.equal(canTransition("submitted", "confirmed"), true);
  assert.equal(canTransition("confirmed", "finalized"), true);
});

// ── timings ───────────────────────────────────────────────────────────────

test("timings are measured from submission, which is what a merchant asked", () => {
  // "How long until my money was safe" starts when they pressed the button,
  // not when the chain happened to confirm.
  const t = timings(
    state({ submittedAt: 1_000, confirmedAt: 1_400, finalizedAt: 13_800 })
  );
  assert.equal(t.confirmationMs, 400);
  assert.equal(t.finalityMs, 12_800);
});

test("an unreached stage is null, not zero", () => {
  const t = timings(state({ submittedAt: 1_000, confirmedAt: 1_400 }));
  assert.equal(t.confirmationMs, 400);
  assert.equal(t.finalityMs, null, "zero would average into the metrics as a real measurement");
});

test("a payment with no timestamps reports nothing rather than guessing", () => {
  const t = timings(state());
  assert.equal(t.confirmationMs, null);
  assert.equal(t.finalityMs, null);
});
