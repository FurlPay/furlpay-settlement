import type { SettlementChain } from "./chains.js";
import { detectConsensus, type ConsensusMode, type ConsensusObservation } from "./alpenglow.js";
import type { SettlementPlan, SettlementTier } from "./tiers.js";

// ---------------------------------------------------------------------------
// Releasing against EVIDENCE rather than against an assertion.
//
// WHY THIS EXISTS ALONGSIDE lifecycle.ts. `releaseDecision` answers "may I
// release?" from a `PaymentStatus` — a string the caller supplies. That is the
// right shape for a product surface that already tracks payment state, and it
// is the wrong shape for a settlement gate, because the safety of the whole
// system then rests on a mapping that lives outside this package. Nothing here
// can tell the difference between a caller who wrote `status: "finalized"`
// because a node said `finalized`, and one who wrote it because a facilitator
// returned `success: true`. Those are not the same fact and only one of them
// is settlement.
//
// So this module takes the observation itself and applies the policy to it.
// The caller supplies what was seen; the policy decides what it means.
//
// THREE RULES, IN PRIORITY ORDER, AND THEY DO NOT BEND:
//
//   1. CONFIRMED IS NOT FINAL. A confirmation requirement is satisfied by a
//      confirmation; a finality requirement is satisfied only by `finalized`.
//      No amount of depth, elapsed time or provider agreement promotes one to
//      the other, because they are different claims about the chain.
//
//   2. UNKNOWN IS CONSERVATIVE. Missing fields, an unrecognised outcome, a
//      consensus mode nobody could establish — each makes the requirement
//      harder to meet, never easier. Being wrong towards HOLD costs a support
//      ticket; being wrong towards RELEASE costs the payment.
//
//   3. EVIDENCE HAS AN AGE AND A SOURCE. A `finalized` read four minutes ago
//      from one node out of five is weaker than a `confirmed` read now from
//      four out of five, and a gate that cannot express that difference will
//      eventually release against a cached answer from a node that has since
//      forked.
//
// WHAT THIS DELIBERATELY DOES NOT DO: decide which consensus is running. That
// is `detectConsensus`, which already resolves certificate > feature gate >
// timings and refuses to guess. Duplicating the thresholds here would let the
// two drift, and the drift would be silent.
// ---------------------------------------------------------------------------

/** What the gate concluded. */
export type SettlementDecision =
  /** The policy is satisfied. Hand over the goods. */
  | "release"
  /** Not yet satisfied, but waiting may satisfy it. Poll again. */
  | "hold"
  /** Waiting cannot satisfy it. The caller must do something else. */
  | "reject";

/**
 * Why the gate concluded what it did.
 *
 * A boolean tells an operator that a payment is stuck. A reason tells them
 * whether to wait, page someone, or refund — so every hold and every reject
 * carries one, and they are a closed set so they can be counted in a dashboard
 * rather than grepped out of prose.
 */
export type SettlementReason =
  // release
  | "confirmation_satisfied"
  | "finality_satisfied"
  // hold — waiting can still fix these
  | "not_yet_observed"
  | "confirmation_pending"
  | "confirmation_depth_insufficient"
  | "finality_required"
  | "consensus_unknown_depth_raised"
  | "stale_observation"
  | "insufficient_provider_evidence"
  | "provider_disagreement"
  // reject — waiting cannot
  | "transaction_failed"
  | "transaction_expired"
  | "policy_unsatisfiable"
  | "malformed_observation";

/** Commitment levels, mirroring what a Solana node reports. */
export type ObservedCommitment = "processed" | "confirmed" | "finalized";

/**
 * What was actually seen on-chain, and how well it was seen.
 *
 * Every field beyond `outcome` is optional, and every missing field makes the
 * decision more conservative rather than less. A caller that can only report
 * "landed at confirmed" still gets a usable answer; it just will not clear a
 * bar that needs evidence it did not supply.
 */
export interface SettlementEvidence {
  /**
   * The chain's answer. Mirrors `ObservedOutcome` in @furlpay/solana-rpc
   * without importing it — this package stays dependency-free, and the two
   * vocabularies are deliberately identical so a caller can map one to the
   * other without interpreting anything.
   */
  outcome: "unknown" | "landed" | "landed_failed" | "expired";
  /** Highest commitment observed for a landed transaction. */
  commitment?: ObservedCommitment;
  /**
   * Confirmations reported by the node.
   *
   * Solana reports `null` once a transaction is rooted — that is the STRONGEST
   * case, not a missing one, so it is distinguished from `undefined`, which
   * means the caller did not look.
   */
  confirmationDepth?: number | null;
  /** Epoch ms when the observation was made. Absent means unknown age. */
  observedAt?: number;
  /** How many providers returned an answer at all. */
  providersAnswered?: number;
  /**
   * How many of those reported the winning commitment.
   *
   * Fewer than `providersAnswered` means the pool disagreed. That is normal
   * (nodes sit at different slots) and it is also what a single lying provider
   * looks like, so it is surfaced rather than averaged away.
   */
  providersAgreeing?: number;
  /** The signature this evidence is about. Carried through for the audit line. */
  txSignature?: string;
}

export interface SettlementGatePolicy {
  /**
   * Minimum confirmations before a confirmation-tier payment may release.
   *
   * One is not enough. A transaction at depth 1 sits in the block most likely
   * to be dropped, and "optimistically confirmed" on Solana means a supermajority
   * voted on the block — not that it cannot be replaced.
   */
  minConfirmationDepth: number;
  /**
   * Extra depth demanded when nobody could establish which consensus is running.
   *
   * Depth means different things under TowerBFT and Alpenglow, so an unknown
   * regime is an unknown yardstick. Raising the bar is the only safe response
   * that still lets small payments through.
   */
  unknownConsensusExtraDepth: number;
  /** How old an observation may be and still be acted on. */
  maxObservationAgeMs: number;
  /** Providers that must have answered before evidence counts at all. */
  minProvidersAnswered: number;
  /**
   * Providers that must agree on the winning commitment.
   *
   * Set to 1 to accept the existing highest-certainty-wins behaviour. Above 1,
   * one optimistic or compromised node can no longer decide a release on its own.
   */
  minProvidersAgreeing: number;
}

/**
 * Defaults chosen to be safe on the slowest assumption, not the fastest.
 *
 * `minProvidersAnswered: 1` keeps single-provider deployments working — raising
 * it would break every caller that has one RPC endpoint, which is most of them
 * on day one. The depth and staleness bounds are where the real protection is,
 * and neither depends on how many nodes a deployment happens to run.
 */
export const DEFAULT_GATE_POLICY: SettlementGatePolicy = {
  minConfirmationDepth: 1,
  unknownConsensusExtraDepth: 0,
  // Two minutes. Long enough to survive a slow poll loop, far short of the
  // window in which a cached answer stops describing the chain.
  maxObservationAgeMs: 120_000,
  minProvidersAnswered: 1,
  minProvidersAgreeing: 1,
};

/**
 * A stricter posture for deployments that can afford it.
 *
 * Not the default, because a policy that nobody can satisfy gets switched off,
 * and a switched-off gate protects nothing.
 */
export const STRICT_GATE_POLICY: SettlementGatePolicy = {
  minConfirmationDepth: 2,
  unknownConsensusExtraDepth: 2,
  maxObservationAgeMs: 30_000,
  minProvidersAnswered: 2,
  minProvidersAgreeing: 2,
};

export interface SettlementAssessment {
  decision: SettlementDecision;
  reason: SettlementReason;
  tier: SettlementTier;
  chain: SettlementChain;
  /** Which consensus the evidence indicates. Never guessed — see alpenglow.ts. */
  consensus: ConsensusMode;
  requiredCommitment: ObservedCommitment;
  observedCommitment: ObservedCommitment | null;
  requiredConfirmationDepth: number;
  observedConfirmationDepth: number | null;
  /** Age of the observation in ms, or null when the caller did not timestamp it. */
  observationAgeMs: number | null;
  providersAnswered: number | null;
  providersAgreeing: number | null;
  txSignature: string | null;
  /** One sentence an operator can act on. */
  message: string;
}

/** The commitment a requirement demands. The whole "confirmed ≠ final" rule. */
function requiredCommitmentFor(plan: SettlementPlan): ObservedCommitment {
  return plan.requires === "confirmation" ? "confirmed" : "finalized";
}

const COMMITMENT_RANK: Record<ObservedCommitment, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

function meets(observed: ObservedCommitment, required: ObservedCommitment): boolean {
  return COMMITMENT_RANK[observed] >= COMMITMENT_RANK[required];
}

function isCommitment(value: unknown): value is ObservedCommitment {
  return value === "processed" || value === "confirmed" || value === "finalized";
}

/**
 * Apply the settlement policy to what was observed.
 *
 * The single invariant this function exists to hold:
 *
 *   A decision of `release` implies the observed chain state satisfied the
 *   plan's requirement, at sufficient depth, recently enough, on evidence from
 *   enough agreeing providers.
 *
 * Every path that cannot establish all four of those returns `hold` or
 * `reject`. There is no path that returns `release` on missing information.
 */
export function assessSettlement(input: {
  evidence: SettlementEvidence;
  plan: SettlementPlan;
  /** What is known about Solana's consensus. Passed to detectConsensus untouched. */
  observation?: ConsensusObservation;
  policy?: SettlementGatePolicy;
  /** Injectable for tests; defaults to now. */
  now?: number;
}): SettlementAssessment {
  const { evidence, plan, observation, policy = DEFAULT_GATE_POLICY, now = Date.now() } = input;

  const consensus = plan.chain === "solana" ? detectConsensus(observation).mode : "towerbft";
  const requiredCommitment = requiredCommitmentFor(plan);

  // Depth requirement is raised, never lowered, when the yardstick is unknown.
  const requiredDepth =
    plan.requires === "confirmation"
      ? policy.minConfirmationDepth +
        (consensus === "unknown" ? policy.unknownConsensusExtraDepth : 0)
      : 0;

  const observedCommitment = isCommitment(evidence.commitment) ? evidence.commitment : null;
  const observedDepth =
    evidence.confirmationDepth === undefined ? null : evidence.confirmationDepth;
  const observationAgeMs =
    typeof evidence.observedAt === "number" && Number.isFinite(evidence.observedAt)
      ? now - evidence.observedAt
      : null;
  const providersAnswered =
    typeof evidence.providersAnswered === "number" ? evidence.providersAnswered : null;
  const providersAgreeing =
    typeof evidence.providersAgreeing === "number" ? evidence.providersAgreeing : null;

  const base = {
    tier: plan.tier,
    chain: plan.chain,
    consensus,
    requiredCommitment,
    observedCommitment,
    requiredConfirmationDepth: requiredDepth,
    observedConfirmationDepth: observedDepth,
    observationAgeMs,
    providersAnswered,
    providersAgreeing,
    txSignature: evidence.txSignature ?? null,
  } as const;

  const hold = (reason: SettlementReason, message: string): SettlementAssessment => ({
    ...base,
    decision: "hold",
    reason,
    message,
  });
  const reject = (reason: SettlementReason, message: string): SettlementAssessment => ({
    ...base,
    decision: "reject",
    reason,
    message,
  });

  // --- Terminal chain outcomes, before anything else. ----------------------
  // A failed transaction reaches `finalized` like any other; checking the
  // outcome first is what stops a failed payment being read as a settled one.
  if (evidence.outcome === "landed_failed") {
    return reject(
      "transaction_failed",
      "The transaction landed on-chain and failed. No value moved; do not release."
    );
  }
  if (evidence.outcome === "expired") {
    return reject(
      "transaction_expired",
      "The transaction expired before inclusion. Nothing settled; it must be resubmitted."
    );
  }
  if (evidence.outcome === "unknown") {
    return hold(
      "not_yet_observed",
      "No provider has seen this transaction yet. This is not evidence that it failed."
    );
  }
  if (evidence.outcome !== "landed") {
    // Reached only when the value came from outside the type system.
    return reject(
      "malformed_observation",
      "The observation is not a recognised outcome and will not be acted on."
    );
  }

  // --- The plan itself may be impossible on this chain. --------------------
  if (plan.unsatisfiable) {
    return reject("policy_unsatisfiable", plan.explanation);
  }

  // --- Evidence quality, before evidence content. --------------------------
  // Checked first because a strong claim from a weak source is exactly the
  // shape of the attack this gate is for.
  if (providersAnswered !== null && providersAnswered < policy.minProvidersAnswered) {
    return hold(
      "insufficient_provider_evidence",
      `Only ${providersAnswered} provider(s) answered; policy requires ${policy.minProvidersAnswered}.`
    );
  }
  if (providersAgreeing !== null && providersAgreeing < policy.minProvidersAgreeing) {
    return hold(
      "provider_disagreement",
      `Only ${providersAgreeing} provider(s) reported this commitment; policy requires ${policy.minProvidersAgreeing}. ` +
        "A single optimistic node is not sufficient evidence to release."
    );
  }
  if (observationAgeMs !== null && observationAgeMs > policy.maxObservationAgeMs) {
    return hold(
      "stale_observation",
      `The observation is ${Math.round(observationAgeMs / 1000)}s old, beyond the ` +
        `${Math.round(policy.maxObservationAgeMs / 1000)}s limit. Re-read the status before releasing.`
    );
  }

  // --- Commitment. ---------------------------------------------------------
  if (observedCommitment === null) {
    return hold(
      "malformed_observation",
      "The transaction landed but no commitment was reported, so its strength is unknown."
    );
  }
  if (!meets(observedCommitment, requiredCommitment)) {
    if (requiredCommitment === "finalized") {
      return hold(
        "finality_required",
        `This ${plan.tier} payment requires finality. Observed ${observedCommitment}; ` +
          "a confirmed transaction can still be dropped by a re-org."
      );
    }
    return hold(
      "confirmation_pending",
      `Observed ${observedCommitment}; this payment needs at least confirmation.`
    );
  }

  // --- Depth, for confirmation-tier releases only. --------------------------
  // A finality requirement is already satisfied by `finalized`; depth adds
  // nothing to a rooted transaction and demanding it would deadlock, because
  // Solana reports null confirmations once rooted.
  if (requiredCommitment === "confirmed" && observedCommitment !== "finalized") {
    // Tested for POSITIVELY, never by falling through a comparison. Every
    // comparison against NaN is false, so `observedDepth < requiredDepth` alone
    // lets a NaN depth past the gate and into a release — which is exactly what
    // an upstream parse failure produces. The invariant sweep in the tests
    // found this; it is the reason the check is shaped this way.
    if (observedDepth === null || !Number.isFinite(observedDepth)) {
      // undefined -> caller did not look. null would have meant rooted, and a
      // rooted transaction reports `finalized`, so it never reaches here.
      return hold(
        "confirmation_depth_insufficient",
        "No usable confirmation depth was reported, so the transaction's burial depth is unknown."
      );
    }
    if (observedDepth < requiredDepth) {
      const reason: SettlementReason =
        consensus === "unknown" && policy.unknownConsensusExtraDepth > 0
          ? "consensus_unknown_depth_raised"
          : "confirmation_depth_insufficient";
      return hold(
        reason,
        `Confirmation depth ${observedDepth} is below the required ${requiredDepth}` +
          (consensus === "unknown"
            ? ", raised because the consensus regime could not be established."
            : ".")
      );
    }
  }

  // --- Everything required has been established. ---------------------------
  return {
    ...base,
    decision: "release",
    reason: requiredCommitment === "finalized" ? "finality_satisfied" : "confirmation_satisfied",
    message:
      requiredCommitment === "finalized"
        ? "Finalized on-chain. Settled and irreversible."
        : `Confirmed at depth ${observedDepth ?? "rooted"}. Safe to release at this amount.`,
  };
}
