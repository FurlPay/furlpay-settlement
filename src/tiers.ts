import { CHAIN_FINALITY, type SettlementChain } from "./chains.js";
import { effectiveFinalityMs, type ConsensusObservation } from "./alpenglow.js";

// ---------------------------------------------------------------------------
// What a payment has to wait for before it counts as settled.
//
// THE SEPARATION THAT MAKES THIS SURVIVE ALPENGLOW: a tier says WHAT to wait
// for, never HOW LONG. How long is a property of the chain and of which
// consensus is currently running on it.
//
// Get that backwards — bake "high value waits 12.8 seconds" into the tier —
// and every tier has to be rewritten the day Solana's finality drops by 99%,
// on a deadline, under pressure. Keep them apart and the same four tiers
// describe the same four risk postures before and after, while the waits move
// underneath on their own.
//
// WHY TIERS AT ALL. Waiting for finality on every payment is the safe answer
// and a terrible product: a coffee costs a customer 13 seconds standing at a
// counter. Never waiting is a fast product that eventually loses real money.
// The tiers are where that trade is made explicitly, once, in a place that can
// be reviewed — rather than implicitly in whichever screen happens to be
// calling.
//
// THE THRESHOLDS ARE A JUDGEMENT, NOT A LAW. They encode one idea: wait for
// finality when the value at risk starts to approach what it would cost an
// attacker to cause a re-org. Below that, an attack loses money and nobody
// rational attempts it.
// ---------------------------------------------------------------------------

export type SettlementTier = "instant" | "standard" | "high_value" | "institutional";

/** What the payment is actually waiting on. */
export type SettlementRequirement =
  /** Block inclusion + optimistic confirmation. Fast, revocable in theory. */
  | "confirmation"
  /** Irreversibility. Slow today on most chains. */
  | "finality"
  /**
   * Finality PLUS a retained on-chain proof. Same wait as `finality`; the
   * difference is what is stored afterwards, which is an audit obligation
   * rather than a timing one.
   */
  | "finality_with_proof";

export interface TierDefinition {
  tier: SettlementTier;
  /** Inclusive lower bound in USD. */
  minUsd: number;
  /** Exclusive upper bound in USD; null for the top tier. */
  maxUsd: number | null;
  requires: SettlementRequirement;
  /** Why this tier draws its line where it does. */
  rationale: string;
}

/**
 * Defaults. Overridable per merchant — a jeweller and a coffee shop have
 * genuinely different risk appetites and should not be forced onto one answer.
 */
export const DEFAULT_TIERS: readonly TierDefinition[] = [
  {
    tier: "instant",
    minUsd: 0,
    maxUsd: 50,
    requires: "confirmation",
    rationale:
      "Below $50 the cost of causing a re-org is orders of magnitude above the value at risk, so waiting for finality buys nothing and costs the customer their time at the counter.",
  },
  {
    tier: "standard",
    minUsd: 50,
    maxUsd: 500,
    requires: "confirmation",
    rationale:
      "Same requirement as instant, tracked separately so a merchant can raise this band to finality without also slowing down every coffee.",
  },
  {
    tier: "high_value",
    minUsd: 500,
    maxUsd: 10_000,
    requires: "finality",
    rationale:
      "Above $500 the value starts to be worth an attack. Release only against irreversibility.",
  },
  {
    tier: "institutional",
    minUsd: 10_000,
    maxUsd: null,
    requires: "finality_with_proof",
    rationale:
      "Same wait as high value, plus a retained settlement proof — at this size the obligation is to be able to evidence settlement later, not merely to be safe now.",
  },
] as const;

export interface TierPolicy {
  tiers: readonly TierDefinition[];
}

export const DEFAULT_POLICY: TierPolicy = { tiers: DEFAULT_TIERS };

/**
 * Which tier a payment falls into.
 *
 * A non-finite or negative amount resolves to the TOP tier rather than
 * throwing. This is deliberate and it is the important edge case: a NaN
 * reaching this function means an upstream parse failed, and the two available
 * behaviours are "refuse to settle without full finality" and "fall through to
 * the fastest tier". Only one of those is safe when the amount is unknown.
 */
export function tierFor(amountUsd: number, policy: TierPolicy = DEFAULT_POLICY): TierDefinition {
  const top = policy.tiers[policy.tiers.length - 1];
  if (!top) throw new Error("Tier policy is empty.");

  if (!Number.isFinite(amountUsd) || amountUsd < 0) return top;

  for (const tier of policy.tiers) {
    const aboveFloor = amountUsd >= tier.minUsd;
    const belowCeiling = tier.maxUsd === null || amountUsd < tier.maxUsd;
    if (aboveFloor && belowCeiling) return tier;
  }
  return top;
}

export interface SettlementPlan {
  tier: SettlementTier;
  requires: SettlementRequirement;
  chain: SettlementChain;
  /**
   * How long this is expected to take, in milliseconds.
   *
   * `null` means the chain cannot answer the question this tier asks — an
   * optimistic rollup has no bounded finality, so a `finality` requirement on
   * one is unsatisfiable by waiting. Callers MUST branch on this rather than
   * defaulting it to a number.
   */
  expectedWaitMs: number | null;
  /**
   * True when the requirement cannot be met on this chain at all. The caller
   * has to do something other than wait: hold the funds in escrow, ask the
   * merchant to accept confirmation, or route the payment elsewhere.
   */
  unsatisfiable: boolean;
  /** One sentence a human can act on. */
  explanation: string;
}

/**
 * Turn an amount and a chain into a plan.
 *
 * This is the whole public point of the package: one function that answers
 * "may I release this yet, and if not, what am I waiting for and for how long".
 */
export function planSettlement(input: {
  amountUsd: number;
  chain: SettlementChain;
  policy?: TierPolicy;
  /** What is known about Solana's consensus. Ignored for other chains. */
  observation?: ConsensusObservation;
}): SettlementPlan {
  const { amountUsd, chain, policy = DEFAULT_POLICY, observation } = input;
  const tier = tierFor(amountUsd, policy);
  const meta = CHAIN_FINALITY[chain];

  if (tier.requires === "confirmation") {
    return {
      tier: tier.tier,
      requires: tier.requires,
      chain,
      expectedWaitMs: meta.confirmMs,
      unsatisfiable: false,
      explanation: `Release on confirmation, about ${formatMs(meta.confirmMs)} on ${chain}.`,
    };
  }

  const finalityMs = effectiveFinalityMs(chain, observation);

  if (finalityMs === null) {
    // The honest, load-bearing branch. Arbitrum is FurlPay's primary rail and
    // it is an optimistic rollup: a $5,000 payment on it cannot be made
    // irreversible by waiting a bounded time. Saying "unsatisfiable" here is
    // what forces the caller to choose a real control instead of silently
    // treating a sequencer confirmation as settlement.
    return {
      tier: tier.tier,
      requires: tier.requires,
      chain,
      expectedWaitMs: null,
      unsatisfiable: true,
      explanation:
        `${chain} has no bounded finality — it inherits settlement from its layer 1 and withdrawals sit behind a challenge window. ` +
        `A payment of this size cannot be made irreversible by waiting. Hold it in escrow, or accept confirmation deliberately.`,
    };
  }

  return {
    tier: tier.tier,
    requires: tier.requires,
    chain,
    expectedWaitMs: finalityMs,
    unsatisfiable: false,
    explanation: `Release on finality, about ${formatMs(finalityMs)} on ${chain}.`,
  };
}

/** Milliseconds as something a person reads without converting. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  return `${Math.round(ms / 60_000)} min`;
}
