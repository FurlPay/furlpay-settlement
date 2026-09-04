// ---------------------------------------------------------------------------
// What "settled" means on each chain FurlPay can move money over.
//
// THE ONE IDEA THIS PACKAGE IS BUILT ON: a payment has two distinct moments,
// and conflating them is the single most common mistake in blockchain payments.
//
//   CONFIRMED — the transaction is in a block and almost certainly staying
//               there. Fast. NOT a guarantee.
//   FINAL     — reverting it is now impossible, not merely expensive. Slow
//               today on most chains, and the only thing a large payment may
//               be released against.
//
// Public writing routinely reports the first number and calls it the second.
// Solana's "400ms" is confirmation; its finality is 12.8 seconds — a 32x
// difference, and the gap where a payments company loses money. Every field
// below is therefore labelled with WHICH moment it measures.
//
// EVERY NUMBER HERE IS SOURCED AND DATED. These change: Solana's Alpenglow
// upgrade collapses its finality by roughly 99% at a feature gate that opens
// 28 September 2026. A constant with no provenance is a constant nobody can
// safely update, so each carries where it came from and when it was checked.
// ---------------------------------------------------------------------------

/** Every chain FurlPay settles on. Mirrors `Chain` in @furlpay/types. */
export type SettlementChain =
  | "ethereum"
  | "polygon"
  | "base"
  | "arbitrum"
  | "solana"
  | "gnosis"
  | "robinhood"
  | "bsc";

/**
 * How a chain reaches irreversibility. This is not trivia — it decides whether
 * "final" is a number we can wait for or a condition we must observe.
 */
export type FinalityModel =
  /** A BFT consensus reaches an irreversible decision at a known cadence. */
  | "bft"
  /**
   * An L2 whose true finality is inherited from its settlement layer. Sequencer
   * inclusion is fast and is NOT finality; a re-org of the L1 batch can still
   * undo it. Treated separately because the honest answer for these is
   * "minutes to days", not "seconds".
   */
  | "l2-inherited";

export interface ChainFinality {
  chain: SettlementChain;
  model: FinalityModel;

  /**
   * Typical time to CONFIRMATION — in a block, overwhelmingly likely to stay.
   * Safe to show a user. Not safe to release large value against.
   */
  confirmMs: number;

  /**
   * Typical time to FINALITY — irreversible.
   *
   * `null` means the chain cannot give a bounded answer, which is the honest
   * value for an optimistic rollup: withdrawal finality is behind a
   * seven-day fraud-proof window. Callers MUST treat null as "cannot wait for
   * this", not as zero — `waitForFinality` refuses rather than guessing.
   */
  finalityMs: number | null;

  /**
   * What the chain's own operators and instrumentation call the finality
   * above, so a reader can check it rather than trusting this file.
   */
  source: string;

  /** ISO date this row was last verified against that source. */
  verifiedOn: string;

  /**
   * Set when the number above is known to be about to change, with what it is
   * changing to and when. Carried in the data rather than in a comment so the
   * UI can warn and so a stale row is visible at runtime.
   */
  pendingChange?: {
    finalityMs: number;
    /** ISO date the change is expected to begin taking effect. */
    expectedFrom: string;
    note: string;
  };
}

/**
 * The table.
 *
 * `satisfies Record<SettlementChain, ChainFinality>` rather than a plain
 * annotation: adding a chain to the union is then a compile error here until
 * somebody states how it finalises. A chain that reaches production with a
 * guessed finality is a chain that releases money too early.
 */
export const CHAIN_FINALITY = {
  solana: {
    chain: "solana",
    model: "bft",
    // Optimistic confirmation. This is the number usually quoted as "Solana is
    // 400ms", and it is not finality.
    confirmMs: 400,
    // TowerBFT: 32 slots at ~400ms. Measured at ~12.8s.
    finalityMs: 12_800,
    source: "Chainspect live metrics; Solana docs (TowerBFT 32-slot finality)",
    verifiedOn: "2026-09-04",
    pendingChange: {
      finalityMs: 150,
      // Anza's published Agave 4.3 schedule. NOT October, which is what most
      // secondary coverage says — the gate opens in September and rolls across
      // subsequent epoch boundaries.
      expectedFrom: "2026-09-28",
      note: "Alpenglow (SIMD-0326). Feature gate opens 2026-09-28, activating across subsequent epochs. Slow path ~150ms, fast path ~100ms. Do NOT apply this number until observed — see alpenglow.ts.",
    },
  },
  ethereum: {
    chain: "ethereum",
    model: "bft",
    confirmMs: 12_000,
    // Casper FFG: two epochs, 32 slots each at 12s.
    finalityMs: 12 * 32 * 2 * 1000,
    source: "Ethereum consensus specs (Casper FFG, 2-epoch finality)",
    verifiedOn: "2026-09-04",
  },
  polygon: {
    chain: "polygon",
    model: "bft",
    confirmMs: 2_000,
    finalityMs: 90_000,
    source: "Polygon PoS checkpoint cadence to Ethereum",
    verifiedOn: "2026-09-04",
  },
  bsc: {
    chain: "bsc",
    model: "bft",
    confirmMs: 3_000,
    finalityMs: 7_500,
    source: "BNB Chain PoSA finality",
    verifiedOn: "2026-09-04",
  },
  gnosis: {
    chain: "gnosis",
    model: "bft",
    confirmMs: 5_000,
    finalityMs: 5 * 16 * 2 * 1000,
    source: "Gnosis Chain consensus (Casper FFG derivative, 5s slots)",
    verifiedOn: "2026-09-04",
  },

  // ── optimistic rollups ───────────────────────────────────────────────────
  //
  // FurlPay's PRIMARY settlement rail is x402 on Arbitrum, so this row is the
  // one that matters most, and it is the one most often got wrong.
  //
  // Sequencer inclusion is ~250ms and feels instant. It is not finality: until
  // the batch is posted and the L1 finalises, a sequencer re-org can undo it,
  // and withdrawal to L1 is behind a seven-day fraud-proof window. There is no
  // single honest millisecond figure, so there is not one here.
  arbitrum: {
    chain: "arbitrum",
    model: "l2-inherited",
    confirmMs: 250,
    finalityMs: null,
    source: "Arbitrum docs — soft confirmation via sequencer; hard finality inherited from Ethereum, withdrawals behind a 7-day challenge window",
    verifiedOn: "2026-09-04",
  },
  base: {
    chain: "base",
    model: "l2-inherited",
    confirmMs: 2_000,
    finalityMs: null,
    source: "OP Stack — sequencer confirmation; finality inherited from Ethereum, 7-day challenge window",
    verifiedOn: "2026-09-04",
  },
  robinhood: {
    chain: "robinhood",
    model: "l2-inherited",
    confirmMs: 2_000,
    finalityMs: null,
    // Stated as unknown rather than assumed. Robinhood Chain is an L2 in the
    // registry; its published finality characteristics have not been verified
    // here, and inventing one would be worse than declining to answer.
    source: "UNVERIFIED — treated as an optimistic rollup pending confirmation of its settlement guarantees",
    verifiedOn: "2026-09-04",
  },
} as const satisfies Record<SettlementChain, ChainFinality>;

/** Compile error if a member of SettlementChain is missing above. */
type MissingChain = Exclude<SettlementChain, keyof typeof CHAIN_FINALITY>;
const _chainsAreExhaustive: MissingChain extends never ? true : MissingChain = true;
void _chainsAreExhaustive;

export function finalityOf(chain: SettlementChain): ChainFinality {
  return CHAIN_FINALITY[chain];
}

/**
 * Whether this chain can give a bounded answer to "when is it irreversible?".
 *
 * False for every optimistic rollup, which is not a defect in the rollup — it
 * is the security model. What it means for FurlPay is that a high-value
 * payment on Arbitrum cannot be released by waiting; it needs a different
 * control (escrow, a hold, or an explicit merchant decision). Saying so is the
 * point of this function.
 */
export function hasBoundedFinality(chain: SettlementChain): boolean {
  return CHAIN_FINALITY[chain].finalityMs !== null;
}

/**
 * True when a row is carrying a change that has not been applied yet.
 *
 * Goes through `finalityOf` rather than indexing the table directly. The table
 * is `as const satisfies`, which narrows every row to its own literal type — so
 * a row without a `pendingChange` genuinely does not have that property, and
 * reading it off the union is a compile error. `finalityOf` widens back to the
 * declared interface, where the field is optional as intended.
 */
export function hasPendingChange(chain: SettlementChain): boolean {
  return finalityOf(chain).pendingChange !== undefined;
}
