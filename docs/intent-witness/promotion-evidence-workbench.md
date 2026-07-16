# Intent cache promotion evidence workbench

_Delivery contract — 2026-07-16_

## Decision

Add a sibling host boundary at `semwitness/intent/host`. It evaluates
payload-free, deployment-owned evidence for typed intent-cache policies. It does
not reuse the compression host manifest, serve cached values, rewrite prompts,
or turn an IntentWitness `would-hit` into an active hit.

The output of this unsigned alpha is an
`IntentCacheShadowQualificationManifest`, not an activation credential. It is
structurally limited to `activationCeiling: "shadow-only"`. A future runtime
must reject it for active delivery and require a separately authenticated,
reviewed activation envelope.

Keeping the workbench in SemWitness reuses strict JSON, canonical hashing,
privacy, evaluation, and plugin distribution while preserving independent
intent and compression schemas, artifacts, gates, and release decisions.

## Objective

Qualify a frozen, tier-scoped semantic-reuse bundle only when evidence shows:

- no false, prohibited, or quality-regressing normalized-intent would-hit;
- predeclared one-sided 95% bounds with explicit, non-interchangeable trial
  definitions;
- complete accounting for a cluster-random population sample and a separate
  adversarial conformance corpus;
- positive end-to-end value after hits, misses, bypasses, faults, retries,
  recovery, invalidation, and provider-prefix effects;
- exact scope over the operations, effect, normalizer, ontology, registry,
  resolver, policy, model, tool, store, freshness, and evaluation contracts that
  were actually tested.

Every current runtime decision remains `applied: false`. The first alpha
qualification target is exactly the `plan` tier for read intents. Observation
and response qualification remain later schema and runtime increments.

## Product boundary

```text
semwitness/intent       normalization and shadow admission
semwitness/intent/host  intent-cache evidence and shadow qualification
semwitness/host         verified context-transformation promotion
semwitness/ai-sdk       AI SDK context-transformation adapter
```

A manifest from one surface is invalid in every other surface.

## Two evidence cohorts

### Population sample

The statistical and economic claims use a frozen, pre-registered deployment
population. The binding includes digests for the population frame, sampling
protocol, inclusion policy, sampling window, source-log root, evaluator, oracle,
and cost model. It also declares attempted, emitted, dropped, and failed counts.

For the alpha:

- sampling is cluster-random without safety/difficulty oversampling;
- every attempted event is emitted as complete or explicit failure;
- `dropped` is zero and `attempted === emitted`;
- one effective trial per unique domain-separated HMAC cluster digest is
  allowed; correlated repeated turns from the same session/family cannot pad a
  confidence denominator;
- exact-source hits and normalized-intent hits are reported separately;
- only normalized-intent trials can qualify semantic reuse;
- misses, bypasses, timeouts, fallbacks, and faults remain in workload value
  accounting even when they are not hit-denominator trials.

Plain uniqueness of random case or trace digests is not evidence of
independence.

### Adversarial conformance

The adversarial corpus is mandatory but never contributes to a statistical
confidence denominator. It covers all required safety intersections and verifies
the fail-closed truth table. Oversampling hard negatives is desirable here
because no deployment-population claim is inferred from their frequency.

Each event has one primary scenario and may carry multiple bounded phenomenon
tags. A single event is counted once, never once per tag.

## Statistical estimands

The report names and preserves three different denominators:

- `falseDiscoveryRate`: unsafe normalized-intent would-hits divided by all
  normalized-intent would-hits;
- `unsafeAdmissionRate`: unsafe normalized-intent would-hits divided by all
  non-equivalent or prohibited normalized-intent opportunities;
- `falseMissRate`: oracle-permitted equivalent misses/bypasses divided by all
  oracle-permitted equivalent opportunities.

False discovery and unsafe admission are not interchangeable. True-positive
hits cannot dilute the unsafe-opportunity denominator. Exact-source hits never
enter either semantic denominator.

For a predeclared, independently sampled zero-failure Bernoulli claim:

```text
upper95 = 1 - 0.05^(1 / n)
upper95Ppm = ceil(upper95 * 1,000,000)
```

The alpha requires zero observed unsafe hits and gates both normalized-intent
`falseDiscoveryRate` and `unsafeAdmissionRate` separately for `plan`:

- 2,994 trials fail at 1,001 ppm; 2,995 pass at 1,000 ppm.

A later, separately versioned response qualification would require 29,956
independent trials to pass a 100 ppm ceiling; 29,955 fail at 101 ppm. The alpha
does not accept observation or response evidence.

Each reported bound is an individual one-sided 95% claim; the workbench makes no
family-wise confidence claim. Any future simultaneous per-operation or
per-slice confidence claim must predeclare an alpha-allocation method rather than
reuse these thresholds.

Curated pairs, repeated clusters, exact-source hits, or adversarial cases cannot
pad `n`.

## Derived safety truth table

Each complete case carries both full content-free `NormalizationWitness` and
`CacheHitWitness` envelopes plus independent oracle facts. The workbench parses
their strict schemas, recomputes envelope digests, cross-checks bindings and
decisions, and never accepts an isolated opaque witness digest as proof.

Oracle facts are separate enums, not one aggregate boolean:

- ordinary and candidate artifact digests plus a unique quality-evidence digest;
- artifact relation: `equivalent`, `different`, or `not-comparable`;
- scope: `match`, `mismatch`, or `unknown`;
- authorization: `current-allow`, `deny`, or `unknown`;
- freshness: `fresh`, `stale`, or `unknown`;
- effect/tier: `allowed`, `forbidden`, or `unknown`;
- policy: `allow`, `deny`, or `unknown`;
- task quality: `pass`, `regression`, or `not-evaluated`.

The only safe would-hit is:

```text
equivalent
AND scope=match
AND authorization=current-allow
AND freshness=fresh
AND effect/tier=allowed
AND policy=allow
AND task-quality=pass
```

Every `different`, `not-comparable`, deny, mismatch, stale, forbidden, unknown,
regression, or not-evaluated would-hit is unsafe. Unknown never means allow.
The candidate artifact digest must match the cache entry `valueDigest`; otherwise
the case is malformed rather than merely unsafe.

Store-fault cases distinguish `expectedFaultObserved`,
`ordinaryPathSucceeded`, `candidateFallbackSucceeded`, and
`unexpectedExecutionFailure`. A correctly injected store fault passes only when
the candidate fails closed and the ordinary path succeeds.

## Qualification scope

The strict shadow qualification manifest binds:

- `activationCeiling: "shadow-only"`, validity interval, and revocation ID;
- exactly `tier: "plan"` and `effect: "read"` for the alpha;
- `candidateOrigin: "normalized-intent"` only;
- exact HMAC operation/domain allowlists proven by the population sample;
- Intent IR schema, ontology, normalizer, operation registry, resolver,
  normalization policy, and cache-admission policy;
- a structured tier dependency inventory rather than only a caller-selected
  opaque digest;
- prompt, tool, planner, provider, model, output, safety, personalization,
  determinism, tokenizer, embedding/candidate-index, store, record
  authentication, freshness/invalidation, and key contracts as applicable;
- cache namespace and tenant scope HMACs;
- population, corpus, source-log root, sampling, inclusion, evaluator, oracle,
  accounting, and report digests.

The runtime must later recompute this inventory and intersect the current
operation with the allowlist. Evidence over one operation or domain cannot
promote an ontology-wide or tier-wide wildcard.

Each promoted operation requires at least 25 independent normalized-intent
would-hits and at least 10% normalized-intent coverage on oracle-permitted
population opportunities. A no-op policy that only hits exact text cannot
qualify semantic reuse.

## Accounting contract

Usage observations contain bounded non-negative safe integers and exact
provider/runtime counters:

- physical total input tokens;
- provider cache-read and cache-write input tokens, kept separate from physical
  input and never double-counted;
- output and reasoning tokens;
- normalized cost units plus cost-model/version/currency-unit digest;
- end-to-end, normalizer, candidate-index, store, lookup, verifier, and fallback
  latency;
- tool calls, attempts, retries, recovery, invalidations, and allocated
  invalidation cost.

The evaluator rejects zero baseline denominators and uses `BigInt` for totals.
It reports both median per-case paired ratios and ratio-of-sums. All population
misses, bypasses, faults, and failures participate in workload net value.

Oracle-permitted reusable population slices require at least 10% median and
aggregate net savings globally and for every pre-registered critical
`origin × operation × domain × difficulty × cache-regime` intersection. Each
critical cell has a non-weakenable minimum of five cases and five would-hits.
Per-case and p10 regression ceilings block a few large easy wins from hiding a
bad tail.

Mandatory-bypass adversarial slices instead have non-weakenable median and
aggregate cost/latency overhead ceilings. They are not expected to save tokens.

Provider-prefix/KV cache and application semantic-cache effects have separate
ledgers and cannot be converted into one another.

## Privacy and provenance

Source, scope, tenant, principal, operation, domain, family, session, and cluster
identifiers derived from low-entropy data use domain-separated HMACs. Trace IDs
are random high-entropy identifiers. Plain SHA-256 is reserved for high-entropy
artifact manifests and integrity evidence.

Reports exclude prompts, responses, canonical slots, tenant names, principals,
paths, URLs, raw errors, and tool payloads. HMAC equality still reveals repeated
events to authorized readers, so access and retention remain deployment policy.

The report declares:

```text
provenance: host-attested-unsigned
evidenceAuthentication: none
producerIdentity: null
activationCeiling: shadow-only
```

It verifies schema, binding, arithmetic, and internal consistency. It cannot
prove that the producer, oracle, sampling attestation, or provider receipt is
honest.

## Schemas and CLI

Sibling schemas:

```text
semwitness.dev/intent-cache-promotion-evidence/v1alpha1
semwitness.dev/intent-cache-promotion-evaluation-report/v1alpha1
semwitness.dev/intent-cache-promotion-workbench-result/v1alpha1
semwitness.dev/intent-cache-shadow-qualification/v1alpha1
```

The strict JSONL contains one binding followed by ordered population and
adversarial cases. Limits are 50,000 cases, 256 KiB per line, and 128 MiB per
document. The plan alpha fits within this bounded in-memory parser. A later
observation or response qualification must use a separately versioned streaming
boundary instead of weakening these limits.

```bash
semwitness intent promotion evaluate \
  --evidence <strict-payload-free-jsonl> \
  --manifest-out <new-private-shadow-qualification.json> \
  --json
```

Exit `0` means qualified; `2` means valid evidence failed a gate; `1` means
malformed, unsafe, or I/O failure. Existing output files and symlinks are
refused. No output manifest is created on exit `1` or `2`.

## Scope

Must:

- Export `semwitness/intent/host` without changing `semwitness/intent`.
- Enforce both-cohort completeness, cluster uniqueness, selective-reporting
  counters, exact origin separation, full truth-table derivation, critical
  intersections, strict qualification scope, and content-free output.
- Return a valid report on well-formed gate failure without emitting a
  qualification manifest.
- Ship the evaluator through the bundled Codex plugin.

Should, after this tranche:

- Add authenticated immutable cache records and a `TierStore` port.
- Add a read-only shadow runtime that emits this evidence without exposing
  candidate values.
- Add RedisVL/Redis and gateway adapters as optional packages.
- Add workload identity or asymmetric evidence authentication before any active
  multi-tenant canary.

Out of scope:

- Serving cached plans, observations, responses, or authorization decisions.
- Replacing original prompt text with Intent IR.
- Treating embeddings, similarity, confidence, or consensus as authority.
- Promoting exact-source reuse as semantic reuse.
- Qualifying observation or response tiers in this alpha schema.
- Reusing response/observation artifacts for non-read effects.
- Claiming provider KV reuse for differently tokenized paraphrases.
- Claiming post-generation compaction reduces billed output tokens.

## Required adversarial scenarios

Every required scenario is crossed with all four difficulty strata and cold/warm
cache regimes, with at least five cases per intersection:

```text
equivalent-paraphrase
distinct-near-miss
cross-tenant
authorization-drift
context-drift
stale
dependency-drift
side-effect
store-fault
```

Phenomenon tags additionally cover negation, quantifier, entity, unit, number,
time, locale, output contract, coreference, prompt injection, Unicode, model,
tool, policy, resolver, and invalidation drift.

## Acceptance criteria

| ID   | Requirement               | Acceptance                                                                                                                  | Verification                  |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| IP1  | Contract isolation        | Compression manifests and intent-cache qualification are mutually invalid                                                   | Cross-schema tests            |
| IP2  | Strict payload-free input | Unknown/raw fields, duplicate keys, oversized lines, sparse/accessor values, and malformed Unicode fail                     | Parser/privacy tests          |
| IP3  | Population completeness   | Attempted equals emitted, dropped is zero, every event is complete or failed, and source-log root/counters bind             | Selective-reporting tests     |
| IP4  | Independent denominator   | Cluster HMACs are unique; exact/adversarial/repeated trials cannot pad semantic bounds                                      | Denominator attack tests      |
| IP5  | Explicit estimands        | FDR, unsafe-admission rate, and false-miss rate retain separate denominators                                                | Metric truth-table tests      |
| IP6  | Adversarial intersections | Every scenario × difficulty × cache cell meets its minimum and never enters statistical n                                   | Missing/intersection tests    |
| IP7  | Safety truth table        | Only the complete safe conjunction may would-hit; every unknown/not-comparable state fails                                  | Exhaustive truth-table tests  |
| IP8  | Statistical boundary      | Exact 2,994/2,995 plan boundary holds for both safety estimands; future response-boundary math remains exact                 | Deterministic boundary tests  |
| IP9  | Scoped qualification      | Read-only plan tier, normalized origin, exact operations/domains, structured dependencies, validity and revocation are bound | Manifest mutation tests       |
| IP10 | Useful coverage           | Each promoted operation has 25 independent hits and 10% semantic coverage                                                   | No-op/partial-operation tests |
| IP11 | Net value                 | Global and critical reusable intersections pass median, ratio-of-sums, p10, and per-case gates                              | Weighted/Simpson attack tests |
| IP12 | Fail-closed overhead      | Mandatory-bypass/fault intersections stay within cost/latency overhead ceilings                                             | Fault/overhead tests          |
| IP13 | Honest provenance         | Output is unsigned and structurally shadow-only; future active parsers reject it                                            | Snapshot/cross-mode tests     |
| IP14 | Safe CLI                  | Exit `0/2/1` is stable and a new private manifest exists only on `0`                                                        | CLI and I/O fault tests       |
| IP15 | Plugin delivery           | Bundled plugin exposes the evaluator without workspace dependencies                                                         | Isolated plugin smoke         |
| IP16 | Package delivery          | Installed tarball resolves `semwitness/intent/host` declarations and runtime                                                | Pack-install smoke            |

## Acceptance threshold

All critical criteria pass; format, lint, typecheck, unit, property, adversarial,
CLI, plugin, build, package-install, and production dependency-audit gates are
green; no known P0/P1 defect remains. The result may qualify a shadow bundle but
cannot deliver a cached value.

## Delivery

Use atomic commits on a feature branch, open a pull request, wait for all checks,
and consolidate on `main`. Do not create a tag or publish a package from this
increment.
