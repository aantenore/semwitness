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
- any population failure is retained in accounting and is a hard qualification
  failure; an expected store fault is a complete fail-closed case, not a
  population failure;
- every emitted event has a unique domain-separated HMAC cluster digest;
  correlated repeated turns from the same session/family are excluded by the
  pre-registered sampling protocol and cannot be selectively reduced to one
  favorable representative;
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
- `unsafeAdmissionRate`: unsafe normalized-intent would-hits divided by every
  normalized-intent unsafe opportunity. An unsafe opportunity has
  `different`/`not-comparable` artifact relation; any negative or unknown scope,
  authorization, freshness, effect, or policy state; or a candidate-bearing
  quality regression/not-evaluated state. A no-candidate permitted-equivalent
  opportunity does not become unsafe merely because candidate quality is
  unavailable;
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

Complete cases use a closed three-path union:

- `candidate-bearing`: full content-free `NormalizationWitness` and
  `CacheHitWitness` envelopes;
- `normalized-no-candidate`: a full normalization witness plus a strict,
  digest-bound lookup receipt for `miss`, `policy-bypass`, `store-fault`,
  `timeout`, or `fallback`; it never invents a cache entry;
- `normalization-bypass`: a strict normalization-bypass receipt and
  `lookup: "not-attempted"`, without a fabricated Intent IR, operation, or
  normalization witness.

The lookup receipt binds `mode: "shadow"`, `applied: false`, source HMAC,
normalizer/ontology/policy contracts, a required observed operation binding,
candidate-index/store contracts, outcome, allowlisted reason, accounting
disposition, and its recomputed digest. The normalization-bypass receipt binds
the same shadow literals, source HMAC, normalizer/ontology/policy contracts,
allowlisted compiler-failure (including abort), registry-mismatch, or no-match
reason, accounting disposition, and its recomputed digest. The workbench parses
these strict schemas,
cross-checks bindings and decisions, and never accepts an isolated opaque
witness digest as proof.

Candidate origin is derived rather than trusted. Because the core cache-entry
envelope intentionally does not contain a source identifier, candidate cases
carry a separate digest-bound `entrySourceBinding` over the entry digest, value
digest, domain-separated entry-source HMAC, and binding digest. The lookup
source HMAC must equal the full normalization witness source digest. Equality
between the bound entry and lookup source HMACs means `exact-source`; inequality
means `normalized-intent`. The entry and value digests must also cross-link the
cache-hit witness. Plain source SHA-256 is rejected at this host boundary. Miss
and bypass are separately derived dispositions, never values of the origin
field.

A normalized-no-candidate path carries one closed reference union: either
`{ kind: "none" }` or a fully attested reference containing the artifact digest,
entry-source HMAC, and operation binding. Independent optional reference fields
are malformed. Only the fully attested, cross-linked variant can enter a
semantic denominator. Source equality is exact and excluded; source inequality
is a normalized-intent opportunity. `kind: "none"` requires artifact relation
`not-comparable` and is diagnostic/value evidence only. Normalization-bypass
paths never enter semantic denominators because no observed typed intent exists.

Every normalized path also carries a content-free operation binding over
operation HMAC, domain HMAC, intent digest, effect, registry digest, ontology
digest, and its own recomputed binding digest. It must cross-link the
normalization, entry/lookup or oracle reference, registry, and ontology
evidence. A normalization-bypass may carry only a separately named
`oracleOperationBinding`, which is never treated as observed. A caller-selected
operation label is not evidence.

Oracle facts are separate enums, not one aggregate boolean. Ordinary artifact
digest is always present. Candidate-bearing paths additionally carry an
`observedCandidateArtifactDigest` and unique quality-evidence digest. A
no-candidate path may carry an independently attested reference artifact digest,
entry-source HMAC, and operation binding; all three are required before it can
count as a false-miss opportunity. Without that reference its artifact relation
is `not-comparable`:

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

For candidate-bearing paths, every `different`, `not-comparable`, deny,
mismatch, stale, forbidden, unknown, regression, or not-evaluated would-hit is
unsafe. Unknown never means allow. The observed candidate artifact digest must
match the cache entry `valueDigest`; otherwise the case is malformed rather than
merely unsafe.

For no-candidate paths, a permission-safe opportunity is `equivalent`, scope
match, current authorization allow, fresh, effect allowed, and policy allow.
Candidate task quality is intentionally excluded because no candidate exists.
A miss or bypass on such a referenced opportunity is false-miss evidence; all
other comparable/unknown paths are classified independently for unsafe
opportunity accounting.

Store-fault cases distinguish `expectedFaultObserved`,
`ordinaryPathSucceeded`, `candidateFallbackSucceeded`, and
`unexpectedExecutionFailure`. A correctly injected store fault passes only when
the candidate fails closed and the ordinary path succeeds.

`side-effect` conformance uses a normalized-no-candidate lookup receipt with
`outcome: "policy-bypass"` and reason `ALPHA_EFFECT_FORBIDDEN` before store
access. It carries a separately bound conformance-only `probeOperation` with
effect `write` or `irreversible`; it does not pretend that the qualified read
operation changed effect. The probe may use a different operation HMAC, but it
must retain the bound domain, ontology, and operation-registry contracts. It is
excluded from qualification scope, population/statistical denominators, and
reusable-value denominators; it remains mandatory in the side-effect truth-table
and overhead gates. A candidate-bearing eligible side-effect record is
well-formed evidence but fails the conformance gate.

## Qualification scope

The strict shadow qualification manifest binds:

- `activationCeiling: "shadow-only"`, validity interval, and revocation ID;
- exactly `tier: "plan"` and `effect: "read"` for the alpha;
- `candidateOrigin: "normalized-intent"` only;
- exactly one qualified read-operation HMAC and one domain HMAC proven by the
  population and every ordinary adversarial scenario for this alpha. The
  side-effect scenario instead uses exactly one separately named
  conformance-only probe operation with the same domain/registry/ontology
  contracts and a `write` or `irreversible` effect; it can never enter the
  allowlist. Multi-operation qualification requires a later schema with an
  explicit multiple-comparison policy;
- Intent IR schema, ontology, normalizer, operation registry, resolver,
  normalization policy, and cache-admission policy;
- a structured tier dependency inventory rather than only a caller-selected
  opaque digest;
- prompt, tool, planner, provider, model, output, safety, personalization,
  determinism, tokenizer, embedding/candidate-index, store, record
  authentication, freshness/invalidation, and key contracts are all bound in
  the alpha. Every slot has status `enabled` or `disabled` and still binds an
  explicit frozen adapter artifact; the evidence producer cannot omit it or
  choose `not-applicable`;
- cache namespace and tenant scope HMACs;
- population, corpus, source-log root, sampling, inclusion, evaluator, oracle,
  accounting, and report digests.

The runtime must later recompute this inventory and intersect the current
operation with the allowlist. Evidence over one operation or domain cannot
promote an ontology-wide or tier-wide wildcard.

The single qualified operation requires at least 25 independent
normalized-intent would-hits and at least 10% normalized-intent coverage on
oracle-permitted population opportunities. The two bundle safety claims must
also each reach 2,995 effective trials for that same operation and domain. A
no-op policy that only hits exact text cannot qualify semantic reuse.

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
Before any arithmetic, both observations in every usage pair must bind the exact
cost-model and currency-unit digests declared by the evidence binding. A pair
from another pricing model or currency is malformed, not a comparable sample.
It reports both median per-case paired ratios and ratio-of-sums. All population
misses, bypasses, faults, and failures participate in workload net value.
Usage is a closed union. Complete usage carries every counter as a bounded
non-negative safe integer. Incomplete usage still carries every counter key,
using `number | null` to distinguish observed from unavailable values plus a
failure digest; omission and imputation are forbidden. Failure records carry
the same union. Any incomplete pair makes value status `unavailable`, and any
population failure blocks qualification regardless of accounting status.

Oracle-permitted normalized-intent reusable population slices require at least
10% median and aggregate net savings globally and in all eight evaluator-owned
`difficulty × cache-regime` cells for the one bound operation/domain. Each cell
has a non-weakenable minimum of five cases and five would-hits. The p10 savings
floor is zero and no individual case may regress by more than 50% (500,000
ppm). Evidence cannot omit or redefine critical cells.

Mandatory-bypass adversarial slices instead have non-weakenable median and
aggregate cost and latency overhead ceilings of 25% (250,000 ppm) in every
scenario/difficulty/cache cell. They are not expected to save tokens. The
`equivalent-paraphrase` scenario is a positive safe-hit conformance case and is
not included in these mandatory-bypass overhead cells.

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
The private evidence file also contains unkeyed high-entropy intent, value, and
witness digests from the base envelopes; these reveal equality and may be
guessable if an upstream artifact has low entropy. Reports and manifests do not
copy the full envelopes. Qualification and Passport files therefore require
owner-only mode `0600`, deployment ACLs, and explicit retention. Do not publish
them as logs, ordinary CI artifacts, issue attachments, or release assets:
stable HMACs and digests still disclose equality and workload shape.

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
semwitness.dev/intent-cache-operation-binding/v1alpha1
semwitness.dev/intent-cache-entry-source-binding/v1alpha1
semwitness.dev/intent-cache-lookup-receipt/v1alpha1
semwitness.dev/intent-normalization-bypass-receipt/v1alpha1
```

### Authoritative assembly

`assembleIntentCachePromotionEvidence({ attestation, cases })` is the public
host boundary for sealing a fixture from already observed records. The host
attestation supplies the qualified operation and domain identifiers, deployment
scope, validity, intent, dependency, sampling, coverage, oracle, evaluator, and
accounting contracts. It declares `population.attempted` and
`adversarial.expected`, but deliberately cannot supply aggregate outcome
counters, cohort corpus digests, a binding kind, or a binding digest. SemWitness
itself fixes the schema, artifact, unsigned provenance, authentication,
shadow-only ceiling, mode, plan tier, read effect, Intent IR schema,
cluster-independence unit, and held-out split literals; these are protocol
invariants rather than host-attested facts.

The assembler treats both arguments as untrusted data-only state. It rejects
accessors without invoking them, Proxy objects without invoking their traps,
custom prototypes, symbol or unknown fields, sparse arrays, oversized cohorts,
and malformed nested records. Each case must already contain its original
ordinal, usage observations, witness or receipt, oracle facts, failure facts,
and valid `caseDigest`. The public `cases` input is typed as
`readonly unknown[]` because validation, not a caller cast to a sealed case
type, establishes trust. The assembler never creates, repairs, sorts, drops, or
relabels a case.

Only these facts are derived after every case has passed the existing strict
parser:

- emitted, complete, and failed counts for each cohort, with population
  `dropped: 0`;
- ordered population and adversarial corpus digests over the supplied case
  digests;
- the final binding digest.

The declared population attempts and adversarial expected count must equal the
dense array length before any case record is read. Each case is then parsed once
and accumulated against the same 256 KiB record and 128 MiB line-terminated
document budgets as strict JSONL. Accumulation stops immediately when either
budget is exceeded. The shared parsed-fixture finalizer applies ordinal
continuity, cohort order, uniqueness, cross-links, contract bindings, digest
validation, and deep-freeze checks without parsing the records a second time.
The returned fixture is a detached, deeply frozen snapshot; later caller
mutation cannot change it. Assembly performs no network, storage, cache, model,
or provider operation.

The strict JSONL contains one binding followed by contiguous ordered population
cases and then contiguous ordered adversarial cases. Ordinals must be exactly
`0..(attempted + expected - 1)` in input order; the parser never sorts or
normalizes evidence before recomputing the ordered corpus digests. Closed
record variants are `population-complete`, `population-failure`,
`adversarial-complete`, and `adversarial-failure`; each complete record contains
exactly one of the three execution paths above. Population is exactly plan/read.
Adversarial evidence is still plan-tier and uses the qualified read operation
except that `side-effect` uses the bound conformance-only write/irreversible
probe described above. Observation and response are malformed in every cohort.
Every runtime decision remains `mode: "shadow"` and `applied: false`.

The public evaluator accepts bounded JSONL bytes/text or an untrusted object
fixture and routes every form through the strict parser before deriving any
report or manifest. Raw derivation remains private; caller-constructed objects
are snapshotted and revalidated, and reported case digests are copied only from
parser-verified records.

Limits are 50,000 cases, 256 KiB per line, and 128 MiB per document. The plan
alpha fits within this bounded in-memory parser. A later observation or response
qualification must use a separately versioned streaming boundary instead of
weakening these limits.

```bash
semwitness intent promotion evaluate \
  --evidence <strict-payload-free-jsonl> \
  --manifest-out <new-private-shadow-qualification.json> \
  --json
```

Exit `0` means qualified. Exit `2` means well-formed evidence failed a gate,
including observed unsafe hits, population failures, or adversarial truth-table
violations. Exit `1` is reserved for malformed schema, tampering/internal
inconsistency, internal errors, or I/O failure. Existing output files and
symlinks are refused. No output manifest is created on exit `1` or `2`. A
successful manifest file is its exact canonical UTF-8 serialization with no
trailing line feed; its digest can therefore be reproduced directly from the
file bytes.

Once emitted, the manifest can be converted into a deterministic, content-free
in-toto Passport Statement v1 with the repository-controlled
[`v0.1` predicate](../attestations/cache-admission-passport/v0.1.md) and checked
against the separate manifest:

```bash
semwitness intent passport create \
  --qualification <new-private-shadow-qualification.json> \
  --statement-out <new-private-passport.statement.json> \
  --json

semwitness intent passport inspect \
  --statement <new-private-passport.statement.json> \
  --qualification <new-private-shadow-qualification.json> \
  --json
```

The Statement file is also exact canonical UTF-8 without a trailing line feed.
Creation stdout is a receipt only; it never echoes the Statement or its scope
HMACs. The inspector distinguishes exact `payloadDigest` from the
extension-eliding `canonicalProfileDigest`. Bounded in-toto extensions may
parse, but their presence sets `extensionsPresent: true` and `bound: false`.

This is a lineage and binding boundary only. `bound: true` does not authenticate
the evidence, enforce the copied RFC 3339 validity or revocation claims, or
authorize a cache hit. See the [Cache Admission Passport Statement
contract](cache-admission-passport.md).

## Scope

Must:

- Export `semwitness/intent/host` without changing `semwitness/intent`.
- Assemble complete host-attested fixtures without manufacturing, repairing,
  sorting, dropping, or relabelling case evidence.
- Enforce both-cohort completeness, cluster uniqueness, selective-reporting
  counters, exact origin separation, full truth-table derivation, critical
  intersections, strict qualification scope, and content-free output.
- Return a valid report on well-formed gate failure without emitting a
  qualification manifest.
- Ship the evaluator through the bundled Codex plugin.

Should, after this tranche:

- Add an external DSSE trust/revocation verifier and a separately authenticated
  approval envelope without changing the Passport's shadow-only meaning. DSSE
  must verify `PAE(payloadType, payload)`, authenticating both the declared type
  and exact payload bytes; the normalized profile digest is not a substitute.
- Keep the implemented per-hit Decision Statement unsigned and shadow-only;
  define a separate authenticated, time/revocation/replay-enforced active
  admission protocol before any serving adapter.
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

Every required scenario is crossed with the literal difficulty strata `simple`,
`medium`, `complex`, and `adversarial` and the cache regimes `cold` and `warm`,
with at least five cases per intersection. The evaluator owns this exact matrix;
the evidence cannot weaken it.

| Primary scenario      | Required path and disposition                                                 |
| --------------------- | ----------------------------------------------------------------------------- |
| equivalent-paraphrase | candidate-bearing safe would-hit                                              |
| distinct-near-miss    | normalized-no-candidate policy bypass                                         |
| cross-tenant          | normalized-no-candidate policy bypass                                         |
| authorization-drift   | normalized-no-candidate policy bypass                                         |
| context-drift         | normalized-no-candidate policy bypass                                         |
| stale                 | normalized-no-candidate policy bypass                                         |
| dependency-drift      | normalized-no-candidate policy bypass                                         |
| side-effect           | normalized-no-candidate policy bypass plus the bound write/irreversible probe |
| store-fault           | normalized-no-candidate store fault with safe fallback facts                  |

Phenomenon tags additionally cover negation, quantifier, entity, unit, number,
time, locale, output contract, coreference, prompt injection, Unicode, model,
tool, policy, resolver, and invalidation drift. Every required tag must appear
at least once in the adversarial corpus; missing phenomenon coverage is a hard
gate even when all scenario intersections are populated.

## Acceptance criteria

| ID   | Requirement               | Acceptance                                                                                                                                                                                           | Verification                  |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| IP1  | Contract isolation        | Compression manifests and intent-cache qualification are mutually invalid                                                                                                                            | Cross-schema tests            |
| IP2  | Strict payload-free input | Unknown/raw fields, duplicate keys, oversized lines, sparse/accessor values, and malformed Unicode fail                                                                                              | Parser/privacy tests          |
| IP3  | Population completeness   | Attempted equals emitted, dropped is zero, source-log root/counters bind, and any explicit population failure blocks                                                                                 | Selective-reporting tests     |
| IP4  | Independent denominator   | Cluster HMACs are unique; exact/adversarial/repeated trials cannot pad semantic bounds                                                                                                               | Denominator attack tests      |
| IP5  | Explicit estimands        | FDR, unsafe-admission rate, and false-miss rate retain separate denominators                                                                                                                         | Metric truth-table tests      |
| IP6  | Adversarial intersections | Every scenario × difficulty × cache cell meets its minimum and never enters statistical n                                                                                                            | Missing/intersection tests    |
| IP7  | Safety truth table        | Only the complete safe conjunction may would-hit; every unknown/not-comparable state fails                                                                                                           | Exhaustive truth-table tests  |
| IP8  | Statistical boundary      | Exact 2,994/2,995 plan boundary holds for both safety estimands; future response-boundary math remains exact                                                                                         | Deterministic boundary tests  |
| IP9  | Scoped qualification      | Read-only plan tier, one operation/domain, every dependency slot, validity and revocation are bound                                                                                                  | Manifest mutation tests       |
| IP10 | Useful coverage           | The one qualified operation has 25 independent hits and 10% semantic coverage                                                                                                                        | No-op/partial-operation tests |
| IP11 | Net value                 | Global and critical reusable intersections pass median, ratio-of-sums, p10, and per-case gates                                                                                                       | Weighted/Simpson attack tests |
| IP12 | Fail-closed overhead      | Mandatory-bypass/fault intersections stay within cost/latency overhead ceilings                                                                                                                      | Fault/overhead tests          |
| IP13 | Honest provenance         | Output is unsigned and structurally shadow-only; future active parsers reject it                                                                                                                     | Snapshot/cross-mode tests     |
| IP14 | Safe CLI                  | Exit `0/2/1` is stable and a new private manifest exists only on `0`                                                                                                                                 | CLI and I/O fault tests       |
| IP15 | Plugin delivery           | Bundled plugin exposes the evaluator without workspace dependencies                                                                                                                                  | Isolated plugin smoke         |
| IP16 | Package delivery          | Installed tarball resolves `semwitness/intent/host` declarations and runtime                                                                                                                         | Pack-install smoke            |
| IP17 | Derived identity          | Source relation and operation/domain scope are recomputed from HMACs, witnesses and binding digests, never caller labels                                                                             | Origin/scope-inflation tests  |
| IP18 | Cohort semantics          | Population and ordinary adversarial cases use the qualified plan/read operation; side-effect uses a scoped-out write/irreversible probe                                                              | Cohort mutation tests         |
| IP19 | Phenomenon coverage       | Every required adversarial phenomenon tag is present at least once and reported deterministically                                                                                                    | Missing-tag mutation tests    |
| IP20 | Authoritative assembly    | Declared cohort sizes are preflighted before record reads; Proxy traps never run; records parse once under JSONL-equivalent byte budgets; only aggregate counters/corpus/binding digests are derived | Assembler boundary tests      |

## Acceptance threshold

All critical criteria pass; format, lint, typecheck, unit, property, adversarial,
CLI, plugin, build, package-install, and production dependency-audit gates are
green; no known P0/P1 defect remains. The result may qualify a shadow bundle but
cannot deliver a cached value.

## Delivery

Use atomic commits on a feature branch, open a pull request, wait for all checks,
and consolidate on `main`. Do not create a tag or publish a package from this
increment.
