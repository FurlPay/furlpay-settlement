import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIERS,
  formatMs,
  planSettlement,
  tierFor,
  type TierPolicy,
} from "../src/tiers.js";
import { ALPENGLOW_FINALITY_MS, TOWERBFT_FINALITY_MS } from "../src/alpenglow.js";

// ---------------------------------------------------------------------------
// Tier selection and settlement planning.
//
// Two properties matter more than the rest:
//
//   1. AN UNKNOWN AMOUNT GETS THE STRICTEST TREATMENT. A NaN reaching this
//      code means an upstream parse failed; the two available behaviours are
//      "demand full finality" and "fall through to the fastest tier", and only
//      one of those is safe.
//
//   2. A TIER NEVER CONTAINS A DURATION. That separation is what lets Solana's
//      finality change by 85x without a tier being touched, and it is asserted
//      directly rather than left as a convention.
// ---------------------------------------------------------------------------

test("amounts land in the expected bands", () => {
  assert.equal(tierFor(0).tier, "instant");
  assert.equal(tierFor(49.99).tier, "instant");
  assert.equal(tierFor(50).tier, "standard");
  assert.equal(tierFor(499.99).tier, "standard");
  assert.equal(tierFor(500).tier, "high_value");
  assert.equal(tierFor(9_999.99).tier, "high_value");
  assert.equal(tierFor(10_000).tier, "institutional");
  assert.equal(tierFor(1_000_000).tier, "institutional");
});

test("boundaries are inclusive-low and exclusive-high, with no gaps", () => {
  // A gap between bands would drop an amount through to the fallback, which is
  // silent and would only be noticed by whoever was on the wrong side of it.
  for (let i = 0; i < DEFAULT_TIERS.length - 1; i++) {
    const current = DEFAULT_TIERS[i]!;
    const next = DEFAULT_TIERS[i + 1]!;
    assert.equal(current.maxUsd, next.minUsd, "bands must meet exactly");
  }
  assert.equal(DEFAULT_TIERS[0]!.minUsd, 0, "the lowest band starts at zero");
  assert.equal(DEFAULT_TIERS[DEFAULT_TIERS.length - 1]!.maxUsd, null, "the top band is open");
});

test("an unknown or nonsensical amount gets the strictest tier", () => {
  // The important edge case. Falling through to `instant` here would mean a
  // failed parse upstream silently becomes a fast release.
  for (const amount of [NaN, Infinity, -Infinity, -1, -0.01]) {
    assert.equal(tierFor(amount).tier, "institutional", `${amount} must be strict`);
  }
});

test("tiers describe a requirement, never a duration", () => {
  // Asserted rather than assumed: the moment a tier grows a `waitMs`, the
  // Alpenglow migration becomes a rewrite of every tier instead of a change to
  // one table.
  for (const tier of DEFAULT_TIERS) {
    const keys = Object.keys(tier);
    for (const key of keys) {
      assert.doesNotMatch(key, /ms$|duration|wait|timeout/i, `${tier.tier}.${key} encodes timing`);
    }
  }
});

test("every tier explains itself", () => {
  for (const tier of DEFAULT_TIERS) {
    assert.ok(tier.rationale.length > 40, `${tier.tier} needs a real rationale`);
  }
});

test("small payments release on confirmation, large ones on finality", () => {
  const coffee = planSettlement({ amountUsd: 4.5, chain: "solana" });
  assert.equal(coffee.requires, "confirmation");
  assert.equal(coffee.expectedWaitMs, 400);
  assert.equal(coffee.unsatisfiable, false);

  const car = planSettlement({ amountUsd: 25_000, chain: "solana" });
  assert.equal(car.requires, "finality_with_proof");
  assert.equal(car.expectedWaitMs, TOWERBFT_FINALITY_MS);
});

test("Alpenglow changes the wait without changing the tier", () => {
  // The single most important behaviour in the package.
  const before = planSettlement({ amountUsd: 5_000, chain: "solana" });
  const after = planSettlement({
    amountUsd: 5_000,
    chain: "solana",
    observation: { votorCertificateSeen: true },
  });

  assert.equal(before.tier, after.tier, "the risk posture is unchanged");
  assert.equal(before.requires, after.requires, "what we wait for is unchanged");
  assert.equal(before.expectedWaitMs, TOWERBFT_FINALITY_MS);
  assert.equal(after.expectedWaitMs, ALPENGLOW_FINALITY_MS, "only the duration moves");
});

test("a finality requirement on an optimistic rollup is unsatisfiable, not slow", () => {
  // Arbitrum is FurlPay's primary rail, so this is the branch that will run in
  // production. Reporting a number here — any number — would let a caller
  // believe waiting makes a $5,000 payment irreversible. It does not.
  const plan = planSettlement({ amountUsd: 5_000, chain: "arbitrum" });
  assert.equal(plan.unsatisfiable, true);
  assert.equal(plan.expectedWaitMs, null);
  assert.match(plan.explanation, /no bounded finality/i);
  assert.match(plan.explanation, /escrow/i, "the caller is told what to do instead");
});

test("small payments on an optimistic rollup are still fine", () => {
  // The rollup's lack of bounded finality does not make a $4 coffee a problem.
  const plan = planSettlement({ amountUsd: 4, chain: "arbitrum" });
  assert.equal(plan.unsatisfiable, false);
  assert.equal(plan.expectedWaitMs, 250);
});

test("a merchant can tighten the policy without touching the code", () => {
  // A jeweller and a coffee shop have genuinely different risk appetites.
  const strict: TierPolicy = {
    tiers: [
      { tier: "instant", minUsd: 0, maxUsd: 5, requires: "confirmation", rationale: "Tips only." },
      { tier: "institutional", minUsd: 5, maxUsd: null, requires: "finality_with_proof", rationale: "Everything else." },
    ],
  };
  assert.equal(tierFor(4, strict).tier, "instant");
  assert.equal(tierFor(6, strict).tier, "institutional");
});

test("an empty policy is refused rather than silently permissive", () => {
  assert.throws(() => tierFor(10, { tiers: [] }), /empty/i);
});

test("durations read as a human would say them", () => {
  assert.equal(formatMs(400), "400ms");
  assert.equal(formatMs(150), "150ms");
  assert.equal(formatMs(1_500), "1.5s");
  assert.equal(formatMs(12_800), "13s");
  assert.equal(formatMs(768_000), "13 min");
});
