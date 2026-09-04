import type { SettlementChain } from "./chains.js";
import type { SettlementPlan, SettlementRequirement, SettlementTier } from "./tiers.js";

// ---------------------------------------------------------------------------
// Where a payment is, and whether it may be released.
//
// THE STATE THIS EXISTS TO ADD IS `confirmed`. FurlPay's send flows currently
// go straight from "submitting" to "settled" the moment the API answers — on
// every rail, including Arbitrum. There is no state meaning "on-chain, not yet
// irreversible", so nothing in the product can distinguish a coffee from a
// five-thousand-dollar transfer, and both are shown to the user as done.
//
// `releasable` IS THE WHOLE API. Every other field is context. A caller asks
// one question — may I hand over the goods? — and the answer must not be
// something they assemble themselves from a status enum and a tier, because
// assembling it in four places is how three of them end up wrong.
//
// FAILING CLOSED IS THE DEFAULT EVERYWHERE. An unknown status, a plan that
// cannot be satisfied, a missing observation: each resolves to "not
// releasable". Being wrong in that direction costs a support ticket. Being
// wrong in the other direction costs the payment.
// ---------------------------------------------------------------------------

export type PaymentStatus =
  /** Built and signed, not yet broadcast. */
  | "created"
  /** Broadcast; not yet seen in a block. */
  | "submitted"
  /** In a block and optimistically confirmed. Fast, revocable in theory. */
  | "confirmed"
  /** Irreversible. */
  | "finalized"
  /** Terminal: did not land. */
  | "failed"
  /** Terminal: the blockhash expired before inclusion. Rebuild and resubmit. */
  | "expired";

export interface PaymentState {
  status: PaymentStatus;
  chain: SettlementChain;
  amountUsd: number;
  /** Present from `confirmed` onward. */
  txSignature?: string;
  /** Epoch ms the transaction was first broadcast. */
  submittedAt?: number;
  /** Epoch ms optimistic confirmation was observed. */
  confirmedAt?: number;
  /** Epoch ms finality was observed. */
  finalizedAt?: number;
}

export interface ReleaseDecision {
  /** May the merchant hand over goods or credit the account? */
  releasable: boolean;
  /** What the payment is waiting on, when it is not releasable. */
  waitingFor: SettlementRequirement | null;
  tier: SettlementTier;
  /** A sentence for the merchant. Never a status code. */
  message: string;
  /**
   * True when waiting cannot resolve this — a terminal failure, or a finality
   * requirement on a chain with no bounded finality. The caller must act
   * rather than poll.
   */
  needsIntervention: boolean;
}

/**
 * The one question: may this payment be released?
 *
 * Takes the plan rather than recomputing it, so a decision can never disagree
 * with the plan the user was shown a moment earlier.
 */
export function releaseDecision(state: PaymentState, plan: SettlementPlan): ReleaseDecision {
  const base = { tier: plan.tier, needsIntervention: false } as const;

  switch (state.status) {
    case "failed":
      return {
        ...base,
        releasable: false,
        waitingFor: null,
        message: "This payment failed. Nothing was transferred — ask the customer to try again.",
        needsIntervention: true,
      };

    case "expired":
      return {
        ...base,
        releasable: false,
        waitingFor: null,
        message:
          "This payment expired before it reached the chain. Nothing was transferred; it needs to be resubmitted.",
        needsIntervention: true,
      };

    case "created":
    case "submitted":
      return {
        ...base,
        releasable: false,
        waitingFor: plan.requires,
        message: "Waiting for the network to accept this payment.",
      };

    case "confirmed":
      // The branch the whole package exists for.
      if (plan.requires === "confirmation") {
        return {
          ...base,
          releasable: true,
          waitingFor: null,
          message: "Confirmed. Safe to release at this amount.",
        };
      }
      if (plan.unsatisfiable) {
        // Confirmed, and finality will never arrive on a bounded schedule.
        // Refusing silently forever would be worse than useless, so the caller
        // is told plainly that waiting is not the answer here.
        return {
          ...base,
          releasable: false,
          waitingFor: plan.requires,
          message: plan.explanation,
          needsIntervention: true,
        };
      }
      return {
        ...base,
        releasable: false,
        waitingFor: plan.requires,
        message: `Confirmed, but not yet irreversible. ${plan.explanation}`,
      };

    case "finalized":
      return {
        ...base,
        releasable: true,
        waitingFor: null,
        message: "Settled and irreversible.",
      };

    default: {
      // An unrecognised status is a bug somewhere upstream, and the safe
      // reading of a bug is "do not release". The exhaustiveness check makes
      // adding a status a compile error, so this only runs against data that
      // came from outside the type system.
      const _exhaustive: never = state.status;
      void _exhaustive;
      return {
        ...base,
        releasable: false,
        waitingFor: plan.requires,
        message: "This payment is in an unrecognised state and will not be released automatically.",
        needsIntervention: true,
      };
    }
  }
}

/** Legal transitions. A payment never moves backwards. */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["submitted", "failed", "expired"],
  submitted: ["confirmed", "failed", "expired"],
  // Reaching `failed` from `confirmed` is possible: a confirmed transaction can
  // still be dropped by a re-org before finality. That possibility is precisely
  // why `confirmed` is not `finalized`, so the machine has to allow it.
  confirmed: ["finalized", "failed"],
  finalized: [],
  failed: [],
  expired: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * How long each stage actually took. Null until the stage is reached.
 *
 * Worth measuring rather than assuming: these are the numbers that tell you
 * whether Alpenglow is live long before anybody publishes a blog post about it,
 * and the numbers that show an RPC provider degrading before users complain.
 */
export function timings(state: PaymentState): {
  confirmationMs: number | null;
  finalityMs: number | null;
} {
  const { submittedAt, confirmedAt, finalizedAt } = state;
  return {
    confirmationMs: submittedAt && confirmedAt ? confirmedAt - submittedAt : null,
    // Measured from SUBMISSION, not from confirmation — "how long until my
    // money was safe" is the question a merchant is asking, and it starts when
    // they pressed the button.
    finalityMs: submittedAt && finalizedAt ? finalizedAt - submittedAt : null,
  };
}
