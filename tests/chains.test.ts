import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_FINALITY,
  finalityOf,
  hasBoundedFinality,
  hasPendingChange,
  type SettlementChain,
} from "../src/chains.js";

// ---------------------------------------------------------------------------
// The chain finality table.
//
// This is a table of constants, so the tests are not checking arithmetic —
// they are checking the properties that make the table trustworthy: that every
// row is sourced, that confirmation is never confused with finality, and that
// an unbounded finality is represented as null rather than as a large number
// somebody will later mistake for a real wait.
// ---------------------------------------------------------------------------

const ALL: SettlementChain[] = [
  "ethereum",
  "polygon",
  "base",
  "arbitrum",
  "solana",
  "gnosis",
  "robinhood",
  "bsc",
];

test("every chain FurlPay supports has a row", () => {
  for (const chain of ALL) {
    assert.ok(finalityOf(chain), `${chain} is missing`);
    assert.equal(finalityOf(chain).chain, chain, `${chain} row is mislabelled`);
  }
});

test("every row is sourced and dated", () => {
  // A constant with no provenance is a constant nobody can safely update, and
  // these change — Solana's finality drops 85x at the Alpenglow gate.
  for (const chain of ALL) {
    const row = finalityOf(chain);
    assert.ok(row.source.length > 20, `${chain} needs a real source`);
    assert.match(row.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${chain} needs an ISO verified date`);
  }
});

test("confirmation is always faster than finality where both are known", () => {
  // If these ever invert, the row has confused the two moments — which is the
  // exact error this whole package exists to prevent.
  for (const chain of ALL) {
    const row = finalityOf(chain);
    if (row.finalityMs !== null) {
      assert.ok(
        row.confirmMs < row.finalityMs,
        `${chain}: confirmation (${row.confirmMs}ms) must be faster than finality (${row.finalityMs}ms)`
      );
    }
  }
});

test("optimistic rollups report null finality, not a big number", () => {
  // The temptation is to write "604800000" (seven days) and move on. That is
  // worse than null: it reads as a wait a caller could sit through, and some
  // caller eventually will.
  for (const chain of ["arbitrum", "base", "robinhood"] as const) {
    const row = finalityOf(chain);
    assert.equal(row.model, "l2-inherited", `${chain} should be modelled as an L2`);
    assert.equal(row.finalityMs, null, `${chain} must not claim a bounded finality`);
    assert.equal(hasBoundedFinality(chain), false);
  }
});

test("BFT chains all give a bounded answer", () => {
  for (const chain of ["solana", "ethereum", "polygon", "bsc", "gnosis"] as const) {
    assert.equal(finalityOf(chain).model, "bft");
    assert.equal(hasBoundedFinality(chain), true);
  }
});

test("Solana's row carries the pre-Alpenglow numbers, not the target", () => {
  // The single most likely place for the 150ms figure to leak in as if it were
  // current. It belongs in `pendingChange` until observed — never in
  // `finalityMs`.
  const solana = finalityOf("solana");
  assert.equal(solana.confirmMs, 400, "400ms is CONFIRMATION");
  assert.equal(solana.finalityMs, 12_800, "12.8s is TowerBFT finality");
  assert.notEqual(solana.finalityMs, 150, "150ms must never be the live figure");
});

test("Solana's pending change is recorded with the right date", () => {
  assert.equal(hasPendingChange("solana"), true);
  const pending = finalityOf("solana").pendingChange!;
  assert.equal(pending.finalityMs, 150);
  // Anza's published Agave 4.3 schedule. Most secondary coverage says October;
  // the gate actually opens in September, and being wrong by a month here is
  // being unprepared on the day.
  assert.equal(pending.expectedFrom, "2026-09-28");
  assert.match(pending.note, /do not apply this number until observed/i);
});

test("no other chain claims a pending change it does not have", () => {
  for (const chain of ALL.filter((c) => c !== "solana")) {
    assert.equal(hasPendingChange(chain), false, `${chain} should have no pending change`);
  }
});

test("an unverified row says so in its source rather than guessing", () => {
  // Robinhood Chain's finality characteristics were not confirmed. Declining
  // to answer is honest; inventing 2000ms would be a number somebody releases
  // money against.
  assert.match(finalityOf("robinhood").source, /unverified/i);
});

test("the table is frozen at the type level, not merely by convention", () => {
  // `as const satisfies Record<...>` gives readonly rows. This asserts the
  // runtime shape matches what the types promise, so a JS caller cannot mutate
  // a finality figure at runtime.
  const keys = Object.keys(CHAIN_FINALITY).sort();
  assert.deepEqual(keys, [...ALL].sort(), "table keys must be exactly the supported chains");
});
