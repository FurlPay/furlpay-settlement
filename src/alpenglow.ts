import { CHAIN_FINALITY } from "./chains.js";

// ---------------------------------------------------------------------------
// Which consensus is actually running on Solana right now.
//
// WHY THIS IS A DETECTOR AND NOT A CONSTANT. Alpenglow (SIMD-0326) collapses
// Solana's finality from ~12.8s to ~150ms. Anza's Agave 4.3 schedule opens the
// feature gate on 2026-09-28, activating across subsequent epoch boundaries —
// so for some window the answer is genuinely "it depends which epoch you are
// in", and after it, the answer could still revert if the feature is rolled
// back.
//
// The tempting shortcut is a date check: `if (now > ACTIVATION) finality = 150`.
// That is wrong in the expensive direction. A date is a PLAN; a feature gate is
// an EVENT, and the two diverge whenever a release slips — which release
// schedules do. An app that starts releasing high-value payments after 150ms
// because a hardcoded date passed, on a network still running TowerBFT, is
// releasing them roughly 12.65 seconds early.
//
// So: nothing here decides that Alpenglow is live. It reports what the caller
// has OBSERVED, and refuses to guess when the caller has observed nothing.
//
// THE THREE STATES ARE NOT TWO. "TowerBFT", "Alpenglow", and "we do not know"
// are distinct, and the third one must not collapse into either. Unknown
// resolves to the SLOWER, safer number, because being late is a support
// ticket and being early is a loss.
// ---------------------------------------------------------------------------

/** Which consensus a Solana observation indicates. */
export type ConsensusMode =
  /** TowerBFT — the pre-Alpenglow protocol. ~12.8s finality. */
  | "towerbft"
  /** Alpenglow (Votor) certificates observed. ~150ms finality. */
  | "alpenglow"
  /**
   * Not established. NOT a synonym for TowerBFT: it means no observation has
   * been supplied, so nothing is known. Resolves to the conservative timing.
   */
  | "unknown";

/**
 * What a caller can observe about the network. Every field is optional because
 * a caller that can only supply some of them should still get a usable answer
 * — a partial observation is better than a fabricated one.
 */
export interface ConsensusObservation {
  /**
   * A Votor/Alpenglow finality certificate was seen in a recent block.
   *
   * This is the strongest possible signal and outranks everything else: the
   * certificate is the consensus, not a proxy for it.
   */
  votorCertificateSeen?: boolean;

  /**
   * The feature gate's on-chain status, if the caller queried it.
   *
   * `getFeature`-style lookup on the SIMD-0326 feature account. "active" means
   * the runtime has it switched on.
   */
  featureGate?: "active" | "pending" | "absent";

  /**
   * Measured finality times, in milliseconds, from recent settled payments.
   *
   * Evidence, not proof. Used only to CORROBORATE — a run of sub-second
   * finalities alongside an active gate raises confidence; on its own it could
   * equally be a measurement bug, and this module will not promote it to a
   * verdict by itself.
   */
  observedFinalityMs?: number[];
}

export interface ConsensusVerdict {
  mode: ConsensusMode;
  /**
   * The finality figure to actually use, in milliseconds. Never null for
   * Solana: both consensus modes give a bounded answer.
   */
  finalityMs: number;
  /** Why this verdict, in a form worth putting in a log or an ops screen. */
  reason: string;
  /**
   * True when the verdict rests on a direct observation of consensus rather
   * than on a default. An ops dashboard should show the difference; a caller
   * releasing money should not care, because the number is safe either way.
   */
  observed: boolean;
}

/** Alpenglow's slow-path finality target. The fast path (~100ms) needs ≥80%
 *  stake; the slower figure is the one to plan against. */
export const ALPENGLOW_FINALITY_MS = 150;

/** TowerBFT, from the chain table so the two cannot drift. */
export const TOWERBFT_FINALITY_MS = CHAIN_FINALITY.solana.finalityMs ?? 12_800;

/**
 * How many observed sub-second finalities corroborate an active gate.
 *
 * Deliberately small, because this is never the deciding evidence — it only
 * ever agrees with a signal that already stands on its own.
 */
const CORROBORATION_SAMPLES = 3;

/** An observed finality under this is inconsistent with TowerBFT. */
const SUB_TOWERBFT_MS = 2_000;

/**
 * Read the network's consensus mode from what was observed.
 *
 * Ordered by strength of evidence, and it stops at the first thing that
 * actually settles the question rather than blending signals into a score —
 * a certificate is not 40% of an answer, it is the answer.
 */
export function detectConsensus(observation: ConsensusObservation = {}): ConsensusVerdict {
  const { votorCertificateSeen, featureGate, observedFinalityMs } = observation;

  // 1. A Votor certificate IS Alpenglow consensus. Nothing outranks it.
  if (votorCertificateSeen === true) {
    return {
      mode: "alpenglow",
      finalityMs: ALPENGLOW_FINALITY_MS,
      reason: "Votor finality certificate observed on-chain.",
      observed: true,
    };
  }

  // 2. The feature gate reports active. Strong, and one step less direct than
  //    a certificate — the gate being on is what makes certificates possible.
  if (featureGate === "active") {
    return {
      mode: "alpenglow",
      finalityMs: ALPENGLOW_FINALITY_MS,
      reason: "Alpenglow feature gate reports active.",
      observed: true,
    };
  }

  // 3. The gate is explicitly NOT active. This is a real observation of
  //    TowerBFT, not a fallback, and it is worth distinguishing in the reason
  //    so an operator can tell "we checked" from "we did not".
  if (featureGate === "pending" || featureGate === "absent") {
    return {
      mode: "towerbft",
      finalityMs: TOWERBFT_FINALITY_MS,
      reason: `Alpenglow feature gate is ${featureGate}; TowerBFT finality applies.`,
      observed: true,
    };
  }

  // 4. Only timings. Suggestive and NOT sufficient.
  //
  //    A run of 150ms finalities is exactly what Alpenglow looks like — and
  //    also exactly what a clock bug, a mislabelled timestamp or a caller
  //    measuring confirmation instead of finality looks like. Promoting this
  //    to a verdict on its own would let a measurement error shorten the wait
  //    on every high-value payment at once, which is the worst available
  //    failure. So it stays `unknown`, with the observation surfaced.
  const samples = observedFinalityMs ?? [];
  const fast = samples.filter((ms) => ms > 0 && ms < SUB_TOWERBFT_MS);
  if (fast.length >= CORROBORATION_SAMPLES) {
    return {
      mode: "unknown",
      finalityMs: TOWERBFT_FINALITY_MS,
      reason:
        `${fast.length} recent payments finalised in under ${SUB_TOWERBFT_MS}ms, which is consistent ` +
        "with Alpenglow — but timings alone do not establish consensus. Query the feature gate to confirm.",
      observed: false,
    };
  }

  // 5. Nothing was observed. Say so, and use the slower number.
  return {
    mode: "unknown",
    finalityMs: TOWERBFT_FINALITY_MS,
    reason:
      "No consensus observation supplied; assuming TowerBFT. This is the safe default, not a measurement.",
    observed: false,
  };
}

/**
 * The finality figure to use for a chain, given what is known about Solana.
 *
 * Every other chain ignores the observation entirely — Alpenglow is a Solana
 * upgrade, and letting an observation of one chain change the timing of
 * another is the kind of coupling that produces an incident nobody can explain.
 */
export function effectiveFinalityMs(
  chain: keyof typeof CHAIN_FINALITY,
  observation?: ConsensusObservation
): number | null {
  if (chain === "solana") return detectConsensus(observation).finalityMs;
  return CHAIN_FINALITY[chain].finalityMs;
}

/**
 * Is the pending Alpenglow change now overdue relative to its published date?
 *
 * Not used to change any timing — it exists so an ops screen can say "the gate
 * opened N days ago and we have still never observed a certificate", which is
 * either a monitoring gap or a slipped release, and both are worth knowing.
 * Reading a date is safe here precisely because nothing is released on it.
 */
export function pendingChangeOverdue(now: Date = new Date()): boolean {
  const pending = CHAIN_FINALITY.solana.pendingChange;
  if (!pending) return false;
  return now.getTime() > Date.parse(pending.expectedFrom);
}
