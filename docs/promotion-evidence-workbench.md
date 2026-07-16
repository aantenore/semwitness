# Promotion Evidence Workbench delivery contract

- Date: 2026-07-16
- Source/plugin snapshot: unreleased `0.5.0-alpha.3`
- Delivery: branch validation, then merge to `main`; no package release in this
  increment

## Outcome

SemWitness will compile deployment-owned, held-out evaluation evidence into the
existing `semwitness.dev/host-promotion/v1alpha1` manifest. Operators will no
longer have to hand-author an activation artifact or trust a local tokenizer
estimate as proof of production benefit.

The workbench is an offline, provider-neutral evaluator. It consumes strict,
payload-free JSONL plus the exact apply-verified policy, emits a deterministic
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

The strict schema has no prompt, response, path, user identifier, provider
payload, or raw error field. Bounded metadata identifiers must nevertheless be
non-sensitive. Opaque SHA-256 digests disclose equality and may be guessable
when derived directly from low-entropy values; a deployment should derive case
identities according to its reviewed privacy protocol.

## Scope

### Must

- Parse bounded strict JSONL with duplicate-key rejection and exact schemas.
- Accept exactly one binding record and a complete ordinal range of paired
  baseline/candidate cases.
- Keep prompts, responses, paths, provider error text, and user identifiers out
  of evidence and reports; require a SHA-256 tokenizer fingerprint rather than
  free-form fingerprint text.
- Bind the artifact, apply-verified policy, deployment scope, corpus,
  evaluation protocol, exact tokenizer, codec set, evaluation design, and gate
  thresholds.
- Require at least 50 held-out cases, all four difficulty strata, both cold and
  warm cache regimes, at least five cases in every stratum/cache cell, at least
  ten complete cases per codec, paired runs, and randomized or counterbalanced
  baseline/candidate order.
- Require unique case, baseline/candidate trace, and quality-evidence digests;
  derive the corpus digest from the ordinal-ordered case digests.
- Require observed exact usage, zero unsafe accepts, zero task-quality
  regressions, no execution failures, and complete deployment-scope evidence.
- Measure physical input-token savings and normalized total-cost savings; use
  the lower ratio as the net promotion ratio.
- Bind the host's inclusion of cache, output, reasoning, compressor/sidecar,
  retry, and recovery cost into normalized cost units through the evaluation
  protocol digest. The workbench validates counters and math but does not
  independently reconstruct provider billing.
- Require median net benefit globally, per codec, per difficulty, per cache
  regime, and per cell, plus aggregate net benefit, to meet both the declared
  threshold and SemWitness's 10% activation floor.
- Enforce median and aggregate latency ceilings plus hard runtime-owned limits
  for individual cost and latency regressions. Evidence may tighten but cannot
  weaken the runtime floors, ceilings, or minimum coverage.
- Limit active promotion in this alpha to policy-eligible `json-jcs@1`.
- Produce byte-stable, payload-free reports independent of JSONL case order.
- Produce no manifest and return verdict exit code `2` when valid evidence
  fails a gate; malformed/I/O output returns `1`; qualified evidence returns
  `0`.
- Refuse manifest overwrite and symbolic-link output through the existing
  private-file writer.
- Re-parse every emitted manifest through the current host manifest validator.

### Should

- Report metrics globally, per codec, per difficulty stratum, per cache regime,
  and for all eight stratum/cache cells, including zero-count cells.
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
    "fingerprint": "sha256:<64 lowercase hex>",
    "reliability": "exact"
  },
  "codecs": [{ "id": "json-jcs", "version": "1" }],
  "design": {
    "pairing": "paired",
    "order": "counterbalanced",
    "requiredStrata": ["simple", "medium", "complex", "adversarial"],
    "requiredCacheRegimes": ["cold", "warm"],
    "minimumCasesPerStratumCacheCell": 5
  },
  "gate": {
    "minimumMedianNetSavingsRatioPpm": 100000,
    "maximumMedianLatencyRegressionRatioPpm": 250000,
    "maximumCaseNetRegressionRatioPpm": 500000,
    "maximumCaseLatencyRegressionRatioPpm": 500000
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
  "caseDigest": "sha256:<64 lowercase hex>",
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
drift, any failed case, replayed digests, a corpus-digest mismatch, or an
underfilled coverage cell prevent promotion. Each baseline/candidate trace pair
must be distinct and all trace and quality digests must be globally unique.
`corpusDigest` is the canonical digest of the case digests in ordinal order, so
case insertion, removal, replacement, or reordering cannot preserve the corpus
binding accidentally.

`totalInputTokens` is the provider-normalized physical total across the whole
baseline or candidate call graph. Cache-read and cache-write counts are subsets
and are never added to it a second time. `normalizedCostUnits` is an integer
unit defined by the bound evaluation protocol and includes every billable input,
cache, output, reasoning, compressor/sidecar, retry, and recovery contribution.
That inclusion is a host attestation: SemWitness verifies bounds, internal
accounting invariants, digest bindings, totals, and ratios, but has no pricing
table or raw provider bill from which to recompute the unit.

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

measuredNetSavingsPpm = min(inputSavingsPpm, costSavingsPpm)

creditedNetSavingsPpm = decision == applied
  ? measuredNetSavingsPpm
  : min(0, measuredNetSavingsPpm)

latencyRegressionPpm = trunc(
  (candidate.endToEndLatencyMicros - baseline.endToEndLatencyMicros)
  * 1_000_000 / baseline.endToEndLatencyMicros
)
```

Math uses `BigInt`. Savings are bounded to
`[-1_000_000_000, 1_000_000]` ppm so a candidate cost explosion remains visible;
latency is bounded to `[-1_000_000, 1_000_000_000]` ppm. The median sorts
numeric values; for even sets it uses the floor of the mean of the two central
values. Aggregate ratios use exact summed counters. Bypassed cases remain in
the corpus: positive measurement noise is credited as zero while negative
delta still counts against the candidate, both per case and in aggregate.

## Gate reasons

Reasons have stable order and include artifact/policy/tokenizer mismatch,
non-exact usage, non-held-out or biased evaluation design, corpus size,
completeness or digest failure, replayed evidence, missing or underfilled
stratum/cache cells, execution/scope/codec failure, unsafe accepts, task
regressions, producer-weakened thresholds, net benefit below global, aggregate,
codec, stratum, cache or cell floors, and median, aggregate, slice or per-case
latency regression above its effective ceiling.

The runtime owns non-weakenable safeguards: 10% minimum net benefit, four
required strata, two required cache regimes, five cases per cell, ten complete
cases per codec, 50 total cases, at most 50% median latency regression, at most
50% individual net regression, and at most 200% individual latency regression.
The evidence may request stricter limits.

Zero observed unsafe accepts is an alpha admission rule, not proof that the
true unsafe-accept probability is zero. In particular, zero events in only 50
independent trials still leaves a rough one-sided 95% upper bound near 5.8%; a
future non-alpha profile should bind an explicit sampling protocol and risk
bound.

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

| ID  | Requirement                    | Verification                                                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| PE1 | Strict, payload-free input     | duplicate-key, extra-field, sentinel, SHA fingerprint, unsafe-integer and ancestor-symlink tests       |
| PE2 | Complete paired corpus         | ordinal, 40-case rejection, failed case, 4x2 coverage, minimum-cell and under-declaration tests        |
| PE3 | Correct deterministic math     | above-safe-range totals, aggregate/cell regressions, bypass credit, order independence and slice tests |
| PE4 | Fail-closed activation         | parameterized gates, replay attempts, producer-weakened thresholds and CLI no-manifest-on-exit-2       |
| PE5 | Existing-host interoperability | generated manifest parses and enables the verified host preparer for matching scope                    |
| PE6 | Deployment binding             | policy/scope/trace mutation, derived corpus digest and unique case/trace/quality digest tests          |
| PE7 | Safe delivery                  | format, lint, typecheck, full tests, build, bundled CLI execution, package dry-run and prod audit      |

## Rollback

The increment is additive. Removing the command/export leaves the v0.5 host
parser and preparer unchanged. No schema migration or stored-state mutation is
required, and no active runtime path changes without a newly generated
promotion manifest.
