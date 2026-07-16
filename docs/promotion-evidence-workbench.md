# Promotion Evidence Workbench delivery contract

- Date: 2026-07-16
- Target: next SemWitness alpha after `v0.5.0-alpha.1`
- Delivery: branch validation, then merge to `main`; no package release in this
  increment

## Outcome

SemWitness will compile deployment-owned, held-out evaluation evidence into the
existing `semwitness.dev/host-promotion/v1alpha1` manifest. Operators will no
longer have to hand-author an activation artifact or trust a local tokenizer
estimate as proof of production benefit.

The workbench is an offline, provider-neutral evaluator. It consumes strict
content-free JSONL plus the exact apply-verified policy, emits a deterministic
report, and emits a promotion manifest only when every hard gate passes.

## Trust boundary

The workbench validates structure, completeness, bindings, accounting
invariants, aggregate math, and policy eligibility. It does not independently
prove that a host used a genuinely held-out corpus or that a provider, runtime,
or task oracle reported honestly. Evidence is therefore labelled
`host-attested-unsigned`, bound by digests, and suitable only inside the
deployment trust boundary that produced it. Signed attestations remain a
separate future capability.

Local BPE/tokenizer estimates are diagnostic inputs, not promotion evidence.
Eligible usage must be observed exactly from provider responses or an exact
runtime accounting boundary. Provider-specific normalization, pricing, task
oracle configuration, retry attribution, and cache semantics are bound by one
evaluation-protocol digest.

## Scope

### Must

- Parse bounded strict JSONL with duplicate-key rejection and exact schemas.
- Accept exactly one binding record and a complete ordinal range of paired
  baseline/candidate cases.
- Keep prompts, responses, paths, provider error text, and user identifiers out
  of evidence and reports.
- Bind the artifact, apply-verified policy, deployment scope, corpus,
  evaluation protocol, exact tokenizer, codec set, evaluation design, and gate
  thresholds.
- Require at least 50 held-out cases, declared difficulty strata, paired runs,
  and randomized or counterbalanced baseline/candidate order.
- Require observed exact usage, zero unsafe accepts, zero task-quality
  regressions, no execution failures, and complete deployment-scope evidence.
- Measure physical input-token savings and normalized total-cost savings; use
  the lower ratio as the net promotion ratio.
- Include cache, output, reasoning, compressor/sidecar, retry, and recovery cost
  in the host-normalized cost units.
- Require the global and per-codec median net ratio to meet both the declared
  threshold and SemWitness's 10% activation floor.
- Enforce the declared latency-regression ceiling.
- Limit active promotion in this alpha to policy-eligible `json-jcs@1`.
- Produce byte-stable, content-free reports independent of JSONL case order.
- Produce no manifest and return verdict exit code `2` when valid evidence
  fails a gate; malformed/I/O output returns `1`; qualified evidence returns
  `0`.
- Refuse manifest overwrite and symbolic-link output through the existing
  private-file writer.
- Re-parse every emitted manifest through the current host manifest validator.

### Should

- Report metrics globally, per codec, per difficulty stratum, and per declared
  cache regime.
- Preserve exact aggregate counters as decimal strings so large fixtures cannot
  overflow JavaScript safe integers.
- Keep the evaluator independent from provider SDKs, network clients, pricing
  APIs, task judges, and tokenizer libraries.
- Bundle the command automatically in the existing Codex plugin runtime.

### Out of scope

- Running provider calls or task judges inside the workbench.
- Storing raw provider payloads, prompts, responses, or evaluation labels.
- Signing evidence or establishing workload identity.
- Activating IntentWitness cache reads.
- Adding a gateway, vector database, semantic cache, tokenizer implementation,
  or pricing-table dependency.
- Publishing a new npm/plugin release.

## Evidence contract

The first non-empty JSONL line is a binding record:

```json
{
  "schema": "semwitness.dev/host-promotion-evidence/v1alpha1",
  "kind": "binding",
  "artifact": {
    "id": "semwitness-text-request-preparer",
    "version": "1"
  },
  "policyDigest": "sha256:<64 lowercase hex>",
  "deploymentScopeDigest": "sha256:<64 lowercase hex>",
  "corpusDigest": "sha256:<64 lowercase hex>",
  "evaluationProtocolDigest": "sha256:<64 lowercase hex>",
  "split": "held-out",
  "usageEvidence": {
    "source": "provider-response",
    "reliability": "exact"
  },
  "expectedCases": 50,
  "tokenizer": {
    "id": "deployment-tokenizer",
    "fingerprint": "reviewed/exact-tokenizer-v1",
    "reliability": "exact"
  },
  "codecs": [{ "id": "json-jcs", "version": "1" }],
  "design": {
    "pairing": "paired",
    "order": "counterbalanced",
    "requiredStrata": ["simple", "medium", "complex", "adversarial"],
    "requiredCacheRegimes": ["cold", "warm"]
  },
  "gate": {
    "minimumMedianNetSavingsRatioPpm": 100000,
    "maximumMedianLatencyRegressionRatioPpm": 250000
  }
}
```

Every complete case carries only opaque digests, bounded enums, booleans, and
integer observations:

```json
{
  "schema": "semwitness.dev/host-promotion-evidence/v1alpha1",
  "kind": "case",
  "ordinal": 0,
  "status": "complete",
  "stratum": "adversarial",
  "cacheRegime": "warm",
  "codec": { "id": "json-jcs", "version": "1" },
  "deploymentScopeDigest": "sha256:<64 lowercase hex>",
  "decision": "applied",
  "baseline": {
    "traceDigest": "sha256:<64 lowercase hex>",
    "totalInputTokens": 1000,
    "cacheReadInputTokens": 800,
    "cacheWriteInputTokens": 0,
    "totalOutputTokens": 100,
    "reasoningOutputTokens": 20,
    "normalizedCostUnits": 350000,
    "endToEndLatencyMicros": 900000,
    "compressorLatencyMicros": 0,
    "attempts": 1,
    "retryCount": 0,
    "recoveryCount": 0
  },
  "candidate": {
    "traceDigest": "sha256:<64 lowercase hex>",
    "totalInputTokens": 700,
    "cacheReadInputTokens": 500,
    "cacheWriteInputTokens": 0,
    "totalOutputTokens": 100,
    "reasoningOutputTokens": 20,
    "normalizedCostUnits": 280000,
    "endToEndLatencyMicros": 1000000,
    "compressorLatencyMicros": 50000,
    "attempts": 1,
    "retryCount": 0,
    "recoveryCount": 0
  },
  "unsafeAccepted": false,
  "taskQualityRegression": false,
  "qualityEvidenceDigest": "sha256:<64 lowercase hex>"
}
```

A failed case is retained instead of being omitted and carries one bounded
failure reason. Missing ordinals, duplicate ordinals, undeclared codecs, scope
drift, or any failed case prevent promotion.

`totalInputTokens` is the provider-normalized physical total across the whole
baseline or candidate call graph. Cache-read and cache-write counts are subsets
and are never added to it a second time. `normalizedCostUnits` is an integer
unit defined by the bound evaluation protocol and includes every billable input,
cache, output, reasoning, compressor/sidecar, retry, and recovery contribution.

## Deterministic metrics

For each complete case:

```text
inputSavingsPpm = trunc(
  (baseline.totalInputTokens - candidate.totalInputTokens) * 1_000_000
  / baseline.totalInputTokens
)

costSavingsPpm = trunc(
  (baseline.normalizedCostUnits - candidate.normalizedCostUnits) * 1_000_000
  / baseline.normalizedCostUnits
)

netSavingsPpm = min(inputSavingsPpm, costSavingsPpm)

latencyRegressionPpm = trunc(
  (candidate.endToEndLatencyMicros - baseline.endToEndLatencyMicros)
  * 1_000_000 / baseline.endToEndLatencyMicros
)
```

Math uses `BigInt`. Savings are bounded to `[-1_000_000, 1_000_000]` ppm.
Latency ratios are bounded to a documented safe range. The median sorts numeric
values; for even sets it uses the floor of the mean of the two central values.
Bypassed cases remain in the corpus and normally contribute zero savings.

## Gate reasons

Reasons have stable order and include artifact/policy/tokenizer mismatch,
non-exact usage, non-held-out or biased evaluation design, corpus size or
completeness failure, missing strata/cache regimes, execution/scope/codec
failure, unsafe accepts, task regressions, savings below the global or per-codec
threshold, and latency regression above the declared threshold.

## CLI

```bash
semwitness promotion evaluate \
  --evidence held-out-evidence.jsonl \
  --policy apply-policy.yaml \
  --manifest-out promotion.json \
  --json
```

`--manifest-out` is optional for a dry run. The deterministic result envelope
is always written to stdout. A gate failure never creates the manifest path.

## Acceptance evidence

| ID  | Requirement                    | Verification                                                                              |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| PE1 | Strict, content-free input     | duplicate-key, extra-field, size, sentinel, unsafe-integer, symlink tests                 |
| PE2 | Complete paired corpus         | ordinal, minimum-size, failed-case, stratum/cache and design tests                        |
| PE3 | Correct deterministic math     | BigInt ratio, median, overflow, order-independence and per-codec tests                    |
| PE4 | Fail-closed activation         | parameterized gate tests and no-manifest-on-exit-2 CLI test                               |
| PE5 | Existing-host interoperability | generated manifest parses and enables the verified host preparer for matching scope       |
| PE6 | Deployment binding             | policy/tokenizer/scope/protocol/trace tampering changes the report digest or fails a gate |
| PE7 | Safe delivery                  | format, lint, typecheck, full tests, build, plugin bundle and package dry-run pass        |

## Rollback

The increment is additive. Removing the command/export leaves the v0.5 host
parser and preparer unchanged. No schema migration or stored-state mutation is
required, and no active runtime path changes without a newly generated
promotion manifest.
