// ---------------------------------------------------------------------------
// @furlpay/settlement — when is a payment actually settled?
//
// Every blockchain payment has two moments that public writing routinely
// conflates: CONFIRMED (in a block, almost certainly staying) and FINAL
// (reverting it is impossible). On Solana today those are 400ms and 12.8
// seconds — a 32x difference, and the gap where a payments company loses money
// by releasing goods against the first number while believing it has the
// second.
//
// This package is one function's worth of idea, spread over four files:
//
//   planSettlement({ amountUsd, chain })  →  what must I wait for, how long
//   releaseDecision(state, plan)          →  may I release this yet
//
// Everything else supports those two.
//
// THREE PROPERTIES WORTH KNOWING BEFORE USING IT:
//
//   1. TIERS SAY WHAT, CHAINS SAY HOW LONG. A tier never contains a duration.
//      That separation is what lets Solana's finality drop by 99% at the
//      Alpenglow gate without a single tier being rewritten.
//
//   2. NOTHING IS ASSUMED ABOUT ALPENGLOW. The consensus mode is detected from
//      supplied observations, never from a date. A hardcoded activation date
//      that arrives before the feature does would shorten the wait on every
//      high-value payment at once — see alpenglow.ts.
//
//   3. `null` MEANS UNANSWERABLE, NOT ZERO. Optimistic rollups — including
//      Arbitrum, FurlPay's primary rail — have no bounded finality. A finality
//      requirement there is reported as unsatisfiable rather than papered over
//      with a number, because the correct response is escrow or an explicit
//      merchant decision, not a longer wait.
//
// Zero dependencies. Node 20+ and Edge compatible.
// ---------------------------------------------------------------------------

export {
  CHAIN_FINALITY,
  finalityOf,
  hasBoundedFinality,
  hasPendingChange,
  type ChainFinality,
  type FinalityModel,
  type SettlementChain,
} from "./src/chains.js";

export {
  ALPENGLOW_FINALITY_MS,
  TOWERBFT_FINALITY_MS,
  detectConsensus,
  effectiveFinalityMs,
  pendingChangeOverdue,
  type ConsensusMode,
  type ConsensusObservation,
  type ConsensusVerdict,
} from "./src/alpenglow.js";

export {
  DEFAULT_POLICY,
  DEFAULT_TIERS,
  formatMs,
  planSettlement,
  tierFor,
  type SettlementPlan,
  type SettlementRequirement,
  type SettlementTier,
  type TierDefinition,
  type TierPolicy,
} from "./src/tiers.js";

export {
  canTransition,
  releaseDecision,
  timings,
  type PaymentState,
  type PaymentStatus,
  type ReleaseDecision,
} from "./src/lifecycle.js";

export {
  assessSettlement,
  DEFAULT_GATE_POLICY,
  STRICT_GATE_POLICY,
  type ObservedCommitment,
  type SettlementAssessment,
  type SettlementDecision,
  type SettlementEvidence,
  type SettlementGatePolicy,
  type SettlementReason,
} from "./src/evidence.js";
