# @furlpay/settlement

**When is a blockchain payment actually settled?**

Every blockchain payment has two moments that public writing routinely conflates:

| | | |
|---|---|---|
| **Confirmed** | In a block, overwhelmingly likely to stay there | Fast |
| **Final** | Reverting it is impossible, not merely expensive | Slow, today |

On Solana those are **400ms** and **12.8 seconds** — a 32× difference. Releasing goods against the first number while believing you have the second is the gap where a payments company loses money.

This package is one idea, spread over four files.

```ts
import { planSettlement, releaseDecision } from "@furlpay/settlement";

const plan = planSettlement({ amountUsd: 5_000, chain: "solana" });
// → { tier: "high_value", requires: "finality", expectedWaitMs: 12800 }

releaseDecision({ status: "confirmed", chain: "solana", amountUsd: 5_000 }, plan);
// → { releasable: false, waitingFor: "finality",
//     message: "Confirmed, but not yet irreversible. Release on finality, about 13s on solana." }
```

A coffee gets a different answer from the same two calls:

```ts
const plan = planSettlement({ amountUsd: 4.5, chain: "solana" });
releaseDecision({ status: "confirmed", chain: "solana", amountUsd: 4.5 }, plan);
// → { releasable: true, message: "Confirmed. Safe to release at this amount." }
```

Zero dependencies. Node 20+ and Edge compatible.

---

## Three properties worth knowing

### 1. Tiers say *what*, chains say *how long*

A tier never contains a duration. `high_value` means "wait for finality" — not "wait 12.8 seconds".

That separation is the whole reason this package survives Alpenglow. When Solana's finality drops by 85×, not one tier is rewritten:

```ts
planSettlement({ amountUsd: 5_000, chain: "solana" });
// → requires: "finality", expectedWaitMs: 12800

planSettlement({
  amountUsd: 5_000,
  chain: "solana",
  observation: { votorCertificateSeen: true },
});
// → requires: "finality", expectedWaitMs: 150     ← only the duration moved
```

### 2. Nothing is assumed about Alpenglow

Consensus mode is **detected from observations, never from a date**.

Anza's schedule opens the Alpenglow feature gate on 2026-09-28. It would be easy to write `if (now > ACTIVATION) finality = 150`. That is wrong in the expensive direction: a date is a *plan*, a feature gate is an *event*, and release schedules slip. An app that shortens its wait because a hardcoded date passed — on a network still running TowerBFT — releases every high-value payment about 12.65 seconds early.

```ts
detectConsensus();                              // → towerbft (12800ms), observed: false
detectConsensus({ featureGate: "active" });     // → alpenglow (150ms),  observed: true
detectConsensus({ votorCertificateSeen: true });// → alpenglow (150ms),  observed: true
```

Fast *timings* alone never shorten the wait. A run of 150ms finalities looks exactly like Alpenglow — and exactly like a clock bug or a caller measuring confirmation and labelling it finality. Timings are surfaced as a prompt to go and check the gate, never promoted to a verdict.

### 3. `null` means unanswerable, not zero

Optimistic rollups — including **Arbitrum, FurlPay's primary rail** — have no bounded finality. Sequencer inclusion is ~250ms and feels instant; it is not finality, and withdrawal sits behind a seven-day challenge window.

```ts
planSettlement({ amountUsd: 5_000, chain: "arbitrum" });
// → { expectedWaitMs: null, unsatisfiable: true,
//     explanation: "arbitrum has no bounded finality … Hold it in escrow,
//                   or accept confirmation deliberately." }
```

Writing `604800000` here would be worse than `null`: it reads as a wait somebody could sit through, and eventually somebody would.

---

## API

| Function | Answers |
|---|---|
| `planSettlement({ amountUsd, chain, policy?, observation? })` | What must I wait for, and how long? |
| `releaseDecision(state, plan)` | May I release this yet? |
| `detectConsensus(observation?)` | Which consensus is Solana running? |
| `tierFor(amountUsd, policy?)` | Which risk band is this payment in? |
| `finalityOf(chain)` | Sourced finality data for one chain |
| `canTransition(from, to)` | Is this state change legal? |
| `timings(state)` | How long did each stage actually take? |

### Default tiers

| Tier | Amount | Requires |
|---|---|---|
| `instant` | < $50 | Confirmation |
| `standard` | $50 – $500 | Confirmation |
| `high_value` | $500 – $10,000 | Finality |
| `institutional` | ≥ $10,000 | Finality + retained proof |

Thresholds are a judgement, not a law — they encode one idea: wait for finality once the value at risk approaches what a re-org would cost an attacker. Pass your own `TierPolicy` to change them; a jeweller and a coffee shop should not be forced onto one answer.

---

## Failing closed

Every ambiguous input resolves to the *stricter* outcome, because being wrong toward "wait" costs a support ticket and being wrong toward "release" costs the payment.

- An amount that is `NaN`, infinite or negative → **top tier**. A failed parse upstream must not become a fast release.
- No consensus observation → **TowerBFT**, and `observed: false` so an operator can tell "we checked" from "we never asked".
- An unrecognised payment status → **not releasable**, needs intervention.
- A stage that has not been reached → `null`, never `0`. A zero would average into your latency metrics as a real measurement.

---

## Chain data

Every row in the finality table carries its source and the date it was verified, because these numbers change and a constant with no provenance is a constant nobody can safely update.

```ts
finalityOf("solana");
// {
//   confirmMs: 400,          ← CONFIRMATION, the number usually quoted
//   finalityMs: 12_800,      ← TowerBFT finality
//   source: "Chainspect live metrics; Solana docs (TowerBFT 32-slot finality)",
//   verifiedOn: "2026-09-04",
//   pendingChange: { finalityMs: 150, expectedFrom: "2026-09-28", … }
// }
```

`pendingChange` is where the 150ms figure lives until it is observed. It is deliberately not `finalityMs`.

One row — Robinhood Chain — is marked `UNVERIFIED` in its source rather than given a guessed number. Declining to answer is honest; a plausible-looking constant is something somebody releases money against.

---

## Testing

```
npm test      # builds, then runs 52 tests under node --test
```

MIT.
