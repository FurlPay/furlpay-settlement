import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALPENGLOW_FINALITY_MS,
  TOWERBFT_FINALITY_MS,
  detectConsensus,
  effectiveFinalityMs,
  pendingChangeOverdue,
} from "../src/alpenglow.js";

// ---------------------------------------------------------------------------
// Consensus detection.
//
// The property defended hardest here is that NOTHING SHORTENS THE WAIT WITHOUT
// EVIDENCE. Alpenglow takes Solana's finality from 12.8s to 150ms — an 85x
// reduction — and the failure mode of getting that wrong is not a slow screen,
// it is releasing high-value payments 12.65 seconds before they are safe, on
// every payment at once.
//
// So every test below is really the same test asked from a different angle:
// can anything other than a direct observation of Alpenglow make this module
// return 150ms?
// ---------------------------------------------------------------------------

test("no observation resolves to TowerBFT, and says it is a default", () => {
  const verdict = detectConsensus();
  assert.equal(verdict.mode, "unknown");
  assert.equal(verdict.finalityMs, TOWERBFT_FINALITY_MS);
  assert.equal(verdict.observed, false);
  // The distinction has to survive into the reason string: an operator reading
  // a log needs to tell "we checked and it is TowerBFT" from "we never asked".
  assert.match(verdict.reason, /safe default, not a measurement/i);
});

test("an empty observation object is the same as none", () => {
  assert.equal(detectConsensus({}).finalityMs, TOWERBFT_FINALITY_MS);
});

test("a Votor certificate is sufficient on its own", () => {
  const verdict = detectConsensus({ votorCertificateSeen: true });
  assert.equal(verdict.mode, "alpenglow");
  assert.equal(verdict.finalityMs, ALPENGLOW_FINALITY_MS);
  assert.equal(verdict.observed, true);
});

test("an active feature gate is sufficient on its own", () => {
  const verdict = detectConsensus({ featureGate: "active" });
  assert.equal(verdict.mode, "alpenglow");
  assert.equal(verdict.finalityMs, ALPENGLOW_FINALITY_MS);
});

test("a certificate outranks a gate that disagrees with it", () => {
  // The certificate IS the consensus; the gate is what makes one possible. If
  // they conflict, the observation of the thing itself wins.
  const verdict = detectConsensus({ votorCertificateSeen: true, featureGate: "pending" });
  assert.equal(verdict.mode, "alpenglow");
});

test("a pending or absent gate is a real TowerBFT observation, not a fallback", () => {
  for (const gate of ["pending", "absent"] as const) {
    const verdict = detectConsensus({ featureGate: gate });
    assert.equal(verdict.mode, "towerbft");
    assert.equal(verdict.finalityMs, TOWERBFT_FINALITY_MS);
    assert.equal(verdict.observed, true, "querying the gate IS an observation");
  }
});

test("fast timings alone NEVER shorten the wait", () => {
  // The load-bearing test. A run of 150ms finalities looks exactly like
  // Alpenglow — and exactly like a clock bug, a mislabelled timestamp, or a
  // caller measuring confirmation and calling it finality. Promoting timings
  // to a verdict would let one measurement error unsafely release every
  // high-value payment on the platform.
  const verdict = detectConsensus({ observedFinalityMs: [140, 155, 149, 151, 138] });
  assert.equal(verdict.mode, "unknown");
  assert.equal(verdict.finalityMs, TOWERBFT_FINALITY_MS);
  assert.equal(verdict.observed, false);
  // But the observation is not thrown away — it tells an operator to go and
  // check the gate.
  assert.match(verdict.reason, /consistent with Alpenglow/i);
  assert.match(verdict.reason, /do not establish consensus/i);
});

test("timings consistent with TowerBFT raise nothing at all", () => {
  const verdict = detectConsensus({ observedFinalityMs: [12800, 12900, 12750] });
  assert.equal(verdict.mode, "unknown");
  assert.doesNotMatch(verdict.reason, /consistent with Alpenglow/i);
});

test("one or two fast samples are not enough to remark on", () => {
  const verdict = detectConsensus({ observedFinalityMs: [150, 148] });
  assert.doesNotMatch(verdict.reason, /consistent with Alpenglow/i);
});

test("nonsense timings are ignored rather than counted", () => {
  // Zero and negative durations are clock errors. Counting them toward the
  // "suspiciously fast" tally would make a broken clock look like an upgrade.
  const verdict = detectConsensus({ observedFinalityMs: [0, -5, 0] });
  assert.doesNotMatch(verdict.reason, /consistent with Alpenglow/i);
});

test("Alpenglow only ever affects Solana", () => {
  // Letting an observation of one chain change the timing of another is the
  // kind of coupling that produces an incident nobody can explain afterwards.
  const seen = { votorCertificateSeen: true };
  assert.equal(effectiveFinalityMs("solana", seen), ALPENGLOW_FINALITY_MS);
  assert.equal(effectiveFinalityMs("ethereum", seen), 12 * 32 * 2 * 1000);
  assert.equal(effectiveFinalityMs("bsc", seen), 7_500);
  // And it cannot invent finality for a chain that has none.
  assert.equal(effectiveFinalityMs("arbitrum", seen), null);
});

test("effectiveFinalityMs with no observation is the conservative number", () => {
  assert.equal(effectiveFinalityMs("solana"), TOWERBFT_FINALITY_MS);
});

test("the overdue check reads the date but never changes a timing", () => {
  // Safe to compare against a date precisely because nothing is released on
  // the result — it exists so an ops screen can say "the gate opened N days
  // ago and we have still never seen a certificate".
  assert.equal(pendingChangeOverdue(new Date("2026-09-04T00:00:00Z")), false);
  assert.equal(pendingChangeOverdue(new Date("2026-10-15T00:00:00Z")), true);

  // The timing is unmoved either way.
  assert.equal(detectConsensus().finalityMs, TOWERBFT_FINALITY_MS);
});

test("the two finality constants are far enough apart to matter", () => {
  // If these ever converge, the tiering in this package stops earning its
  // complexity — worth noticing rather than discovering.
  assert.ok(TOWERBFT_FINALITY_MS / ALPENGLOW_FINALITY_MS > 50);
});
