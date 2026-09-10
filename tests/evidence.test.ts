import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessSettlement,
  DEFAULT_GATE_POLICY,
  STRICT_GATE_POLICY,
  type SettlementEvidence,
} from "../src/evidence.js";
import { planSettlement } from "../src/tiers.js";
import type { ConsensusObservation } from "../src/alpenglow.js";

// ---------------------------------------------------------------------------
// Adversarial tests for the settlement gate.
//
// The invariant under test, stated once:
//
//   No input may produce `release` unless the observed chain state satisfied
//   the plan's requirement, at sufficient depth, recently enough, on evidence
//   from enough agreeing providers.
//
// Every test below is an attempt to get `release` out of the gate without
// satisfying all four. The last test is the sweep: it enumerates malformed and
// partial observations and asserts none of them release.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-10T12:00:00Z");

/** $10 on Solana — a confirmation-tier payment. */
const instantPlan = planSettlement({ amountUsd: 10, chain: "solana" });
/** $5,000 on Solana — a finality-tier payment. */
const highValuePlan = planSettlement({ amountUsd: 5_000, chain: "solana" });
/** $5,000 on Arbitrum — finality required, no bounded finality available. */
const rollupPlan = planSettlement({ amountUsd: 5_000, chain: "arbitrum" });

const ALPENGLOW: ConsensusObservation = { votorCertificateSeen: true };
const TOWERBFT: ConsensusObservation = { featureGate: "pending" };

function evidence(over: Partial<SettlementEvidence> = {}): SettlementEvidence {
  return {
    outcome: "landed",
    commitment: "confirmed",
    confirmationDepth: 5,
    observedAt: NOW,
    providersAnswered: 3,
    providersAgreeing: 3,
    txSignature: "sig",
    ...over,
  };
}

function assess(ev: SettlementEvidence, plan = instantPlan, opts: Record<string, unknown> = {}) {
  return assessSettlement({ evidence: ev, plan, now: NOW, ...opts });
}

// ── Confirmation ───────────────────────────────────────────────────────────

test("visible but unconfirmed holds", () => {
  const r = assess(evidence({ commitment: "processed" }));
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "confirmation_pending");
});

test("confirmed satisfies a confirmation tier", () => {
  const r = assess(evidence());
  assert.equal(r.decision, "release");
  assert.equal(r.reason, "confirmation_satisfied");
});

test("confirmed does NOT satisfy a finality tier", () => {
  const r = assess(evidence(), highValuePlan);
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "finality_required");
});

test("depth exactly at the threshold releases", () => {
  const r = assess(evidence({ confirmationDepth: DEFAULT_GATE_POLICY.minConfirmationDepth }));
  assert.equal(r.decision, "release");
});

test("depth one below the threshold holds", () => {
  const r = assess(
    evidence({ confirmationDepth: STRICT_GATE_POLICY.minConfirmationDepth - 1 }),
    instantPlan,
    { policy: STRICT_GATE_POLICY, observation: TOWERBFT }
  );
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "confirmation_depth_insufficient");
});

test("a landed transaction with no depth reported holds", () => {
  const r = assess(evidence({ confirmationDepth: undefined }));
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "confirmation_depth_insufficient");
});

// ── Finality ───────────────────────────────────────────────────────────────

test("finalized satisfies a finality tier", () => {
  const r = assess(evidence({ commitment: "finalized", confirmationDepth: null }), highValuePlan);
  assert.equal(r.decision, "release");
  assert.equal(r.reason, "finality_satisfied");
});

test("finalized needs no depth — a rooted transaction reports null confirmations", () => {
  const r = assess(
    evidence({ commitment: "finalized", confirmationDepth: null }),
    instantPlan,
    { policy: STRICT_GATE_POLICY }
  );
  assert.equal(r.decision, "release");
});

test("a failed transaction is rejected even at finalized", () => {
  const r = assess(evidence({ outcome: "landed_failed", commitment: "finalized" }), highValuePlan);
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "transaction_failed");
});

test("an expired transaction is rejected, not held", () => {
  const r = assess(evidence({ outcome: "expired" }));
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "transaction_expired");
});

test("stale finality holds rather than releasing", () => {
  const r = assess(
    evidence({
      commitment: "finalized",
      confirmationDepth: null,
      observedAt: NOW - DEFAULT_GATE_POLICY.maxObservationAgeMs - 1,
    }),
    highValuePlan
  );
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "stale_observation");
});

// ── Consensus ──────────────────────────────────────────────────────────────

test("TowerBFT is reported when the gate is pending", () => {
  const r = assess(evidence(), instantPlan, { observation: TOWERBFT });
  assert.equal(r.consensus, "towerbft");
});

test("Alpenglow is reported only on a certificate", () => {
  const r = assess(evidence(), instantPlan, { observation: ALPENGLOW });
  assert.equal(r.consensus, "alpenglow");
});

test("no observation resolves to unknown, never to alpenglow", () => {
  const r = assess(evidence());
  assert.equal(r.consensus, "unknown");
});

test("fast timings alone never produce alpenglow", () => {
  const r = assess(evidence(), instantPlan, {
    observation: { observedFinalityMs: [120, 140, 150, 130] },
  });
  assert.equal(r.consensus, "unknown");
});

test("unknown consensus raises the depth bar under a strict policy", () => {
  const depth = STRICT_GATE_POLICY.minConfirmationDepth;
  // Satisfies the base bar, but not the raised one.
  const r = assess(evidence({ confirmationDepth: depth }), instantPlan, {
    policy: STRICT_GATE_POLICY,
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "consensus_unknown_depth_raised");
  assert.equal(
    r.requiredConfirmationDepth,
    depth + STRICT_GATE_POLICY.unknownConsensusExtraDepth
  );
});

test("the same depth releases once the regime is established", () => {
  const depth = STRICT_GATE_POLICY.minConfirmationDepth;
  const r = assess(evidence({ confirmationDepth: depth }), instantPlan, {
    policy: STRICT_GATE_POLICY,
    observation: TOWERBFT,
  });
  assert.equal(r.decision, "release");
});

test("a regime transition mid-flight never weakens an in-flight decision", () => {
  // Same evidence assessed under each regime: the decision may not become more
  // permissive simply because Alpenglow arrived.
  const ev = evidence({ commitment: "confirmed", confirmationDepth: 0 });
  const before = assess(ev, highValuePlan, { policy: STRICT_GATE_POLICY, observation: TOWERBFT });
  const after = assess(ev, highValuePlan, { policy: STRICT_GATE_POLICY, observation: ALPENGLOW });
  assert.equal(before.decision, "hold");
  assert.equal(after.decision, "hold", "Alpenglow must not promote confirmed to final");
  assert.equal(after.reason, "finality_required");
});

// ── Provider evidence ──────────────────────────────────────────────────────

test("a single agreeing provider cannot release under a quorum policy", () => {
  const r = assess(evidence({ providersAnswered: 3, providersAgreeing: 1 }), instantPlan, {
    policy: STRICT_GATE_POLICY,
    observation: TOWERBFT,
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "provider_disagreement");
});

test("too few providers answered holds", () => {
  const r = assess(evidence({ providersAnswered: 1, providersAgreeing: 1 }), instantPlan, {
    policy: STRICT_GATE_POLICY,
    observation: TOWERBFT,
  });
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "insufficient_provider_evidence");
});

test("one lying provider claiming finalized cannot release a high-value payment", () => {
  // The attack: four nodes say processed, one says finalized. Highest-certainty
  // merging upstream would hand this gate `finalized`; the quorum check is what
  // stops it becoming money.
  const r = assess(
    evidence({ commitment: "finalized", confirmationDepth: null, providersAnswered: 5, providersAgreeing: 1 }),
    highValuePlan,
    { policy: STRICT_GATE_POLICY }
  );
  assert.equal(r.decision, "hold");
  assert.equal(r.reason, "provider_disagreement");
});

// ── Unsatisfiable plans ────────────────────────────────────────────────────

test("finality on an optimistic rollup is rejected, not held forever", () => {
  const r = assess(evidence({ commitment: "finalized", confirmationDepth: null }), rollupPlan);
  assert.equal(r.decision, "reject");
  assert.equal(r.reason, "policy_unsatisfiable");
});

// ── Explainability ─────────────────────────────────────────────────────────

test("every assessment carries the numbers behind it", () => {
  const r = assess(evidence(), highValuePlan, { observation: TOWERBFT });
  assert.equal(r.requiredCommitment, "finalized");
  assert.equal(r.observedCommitment, "confirmed");
  assert.equal(r.tier, "high_value");
  assert.equal(r.chain, "solana");
  assert.equal(r.txSignature, "sig");
  assert.equal(r.observationAgeMs, 0);
  assert.ok(r.message.length > 0);
});

// ── The invariant sweep ────────────────────────────────────────────────────

test("INVARIANT: no malformed or partial observation ever releases", () => {
  const malformed: SettlementEvidence[] = [
    { outcome: "unknown" },
    { outcome: "landed" }, // no commitment
    { outcome: "landed", commitment: "processed" },
    { outcome: "landed_failed", commitment: "finalized", confirmationDepth: null },
    { outcome: "expired", commitment: "finalized" },
    { outcome: "landed", commitment: undefined, confirmationDepth: 99 },
    // Values that only reach here from outside the type system.
    { outcome: "landed", commitment: "FINALIZED" as never, confirmationDepth: 99 },
    { outcome: "landed", commitment: "" as never },
    { outcome: "landed", commitment: null as never },
    { outcome: "" as never },
    { outcome: "settled" as never, commitment: "finalized" },
    { outcome: "landed", commitment: "confirmed", confirmationDepth: -1 },
    { outcome: "landed", commitment: "confirmed", confirmationDepth: Number.NaN },
  ];

  for (const ev of malformed) {
    for (const plan of [instantPlan, highValuePlan, rollupPlan]) {
      for (const obs of [undefined, TOWERBFT, ALPENGLOW]) {
        const r = assessSettlement({ evidence: ev, plan, now: NOW, observation: obs });
        assert.notEqual(
          r.decision,
          "release",
          `released on ${JSON.stringify(ev)} / ${plan.tier} / ${JSON.stringify(obs)}`
        );
      }
    }
  }
});

test("INVARIANT: a release always implies the required commitment was met", () => {
  const commitments = ["processed", "confirmed", "finalized", undefined] as const;
  const depths = [undefined, null, -1, 0, 1, 2, 5, 32] as const;
  const ages = [0, 1_000, 60_000, 600_000] as const;

  let releases = 0;
  for (const commitment of commitments) {
    for (const confirmationDepth of depths) {
      for (const age of ages) {
        for (const plan of [instantPlan, highValuePlan]) {
          const r = assessSettlement({
            evidence: {
              outcome: "landed",
              commitment,
              confirmationDepth,
              observedAt: NOW - age,
              providersAnswered: 2,
              providersAgreeing: 2,
            },
            plan,
            now: NOW,
            observation: TOWERBFT,
          });
          if (r.decision !== "release") continue;
          releases++;
          // The four conditions, asserted rather than assumed.
          assert.ok(r.observedCommitment, "released with no observed commitment");
          const rank = { processed: 0, confirmed: 1, finalized: 2 } as const;
          assert.ok(
            rank[r.observedCommitment] >= rank[r.requiredCommitment],
            `released at ${r.observedCommitment} against required ${r.requiredCommitment}`
          );
          assert.ok(
            r.observationAgeMs === null || r.observationAgeMs <= DEFAULT_GATE_POLICY.maxObservationAgeMs,
            "released on a stale observation"
          );
          if (r.observedCommitment === "confirmed") {
            assert.ok(
              (r.observedConfirmationDepth ?? -1) >= r.requiredConfirmationDepth,
              "released below the required depth"
            );
          }
        }
      }
    }
  }
  assert.ok(releases > 0, "the sweep never released — the test would be vacuous");
});
