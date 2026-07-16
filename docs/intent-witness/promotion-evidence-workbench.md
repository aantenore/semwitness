# Intent cache promotion evidence workbench

_Delivery contract — 2026-07-16_

## Decision

Add a sibling host boundary at `semwitness/intent/host`. It qualifies typed
intent-cache policies from payload-free, deployment-owned held-out evidence. It
does not reuse the compression host manifest, serve cached values, rewrite
prompts, or turn an IntentWitness `would-hit` into an active hit.

The workbench is the first production-facing slice between the current
Normalizer Lab and a future authenticated shadow runtime. Keeping it in the
SemWitness repository reuses strict JSON, canonical hashing, evaluation, privacy,
and plugin distribution without coupling the intent and compression contracts.

## Objective

Compile paired ordinary-path and candidate-path observations into a tier-scoped
promotion manifest only when the evidence demonstrates all of the following:

- no false, prohibited, or quality-regressing would-hit;
- a predeclared one-sided 95% false-hit upper bound;
- exact provider/runtime accounting and positive end-to-end value;
- complete held-out coverage across difficulty, cache regime, and required
  safety scenarios;
- exact binding to the evaluated normalizer, ontology, policy, runtime, store,
  dependency contract, and deployment scope.

The manifest is evidence for a later, separately reviewed runtime. This tranche
contains no cache-value delivery API, so every current runtime decision remains
`applied: false`.

## Product boundary

```text
semwitness/intent       normalization and shadow admission
semwitness/intent/host  intent-cache evidence and tier-scoped promotion
semwitness/host         verified context-transformation promotion
semwitness/ai-sdk       AI SDK context-transformation adapter
```

The four surfaces have independent schemas, artifacts, reason codes, and
promotion gates. A manifest from one surface is invalid in every other surface.

## Scope

Must:

- Export `semwitness/intent/host` without changing `semwitness/intent` behavior.
- Parse bounded strict JSONL containing exactly one binding followed by ordered
  case records. Reject duplicate keys, unknown fields, sparse data, malformed
  Unicode, oversized input, and extra binding records.
- Accept content-free evidence only: opaque SHA-256 digests, bounded enums,
  counters, decisions, and allowlisted reason codes. Prompt, response, tenant,
  principal, path, URL, raw error, and tool payload fields are invalid.
- Bind every case to one deployment scope and one cache tier.
- Require held-out, paired execution with randomized or counterbalanced order,
  exact provider/runtime usage, and an explicitly attested independent sampling
  protocol.
- Require four difficulty strata, cold and warm cache regimes, and every
  declared safety scenario with a non-weakenable minimum per cell.
- Derive false hits, false misses, prohibited hits, and quality regressions from
  typed oracle and decision fields instead of trusting aggregate counters.
- Require zero false hits, prohibited hits, task-quality regressions, duplicate
  case/trace/quality evidence, and execution failures.
- Calculate the exact zero-failure, one-sided 95% upper confidence bound. The
  runtime ceiling is 1,000 ppm for `plan` and `observation`, and 100 ppm for
  `response`; evidence cannot configure a weaker ceiling.
- Measure physical input tokens, provider cache reads/writes, output/reasoning
  tokens, total normalized cost, latency, normalizer/lookup/verifier overhead,
  retries, recovery, and invalidations. Provider-prefix and semantic-cache
  effects remain separate.
- Require at least 10% median and aggregate net savings globally and in every
  required difficulty/cache slice of oracle-permitted reuse. Safety scenarios
  that must bypass instead have a non-weakenable median and aggregate overhead
  ceiling. A high hit rate cannot compensate for a negative reusable slice or
  unbounded fail-closed overhead.
- Emit one promotion manifest for exactly one tier and one dependency bundle.
  Promotion of `plan` cannot promote `observation` or `response`.
- Return a valid evaluation report and exit code `2` when evidence is well-formed
  but unqualified. Never create a manifest in that case.
- Label evidence provenance `host-attested-unsigned`. Hashes prove integrity and
  binding, not producer identity or truthfulness.
- Ship the evaluator through the bundled Codex plugin.

Should, after this tranche:

- Add authenticated immutable cache records and a `TierStore` port.
- Add a read-only shadow runtime that verifies records, executes ordinary work,
  and emits this evidence without exposing candidate values.
- Add RedisVL/Redis and gateway adapters as optional packages rather than core
  dependencies.
- Add workload-identity or asymmetric evidence authentication before an active
  multi-tenant canary.

Out of scope:

- Serving a cached plan, observation, response, or authorization decision.
- Replacing original prompt text with Intent IR.
- Treating embeddings, similarity, compiler confidence, or consensus as cache
  authority.
- Reusing a response for `write` or `irreversible` intents.
- Claiming provider KV reuse for differently tokenized paraphrases.
- Claiming that post-generation compaction reduces already billed output tokens.

## Evidence contract

The JSONL fixture contains one `binding` record and `expectedCases` case records.
The binding declares the evaluated artifacts, sampling and pairing protocol,
required coverage, and gates. Each case carries:

- ordinal plus unique case, trace, and quality-evidence digests;
- tier, difficulty, cache regime, and one required scenario;
- exact-source, normalized-intent, miss, or bypass candidate origin;
- ordinary and candidate usage observations;
- the shadow decision and content-free witness digests;
- an oracle relation (`equivalent`, `different`, or `not-comparable`) and whether
  reuse is permitted under current authorization, freshness, effect, and policy;
- no source or artifact payload.

Required safety scenarios are:

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

A would-hit is false when the independently executed artifact is not equivalent.
It is prohibited when the oracle says reuse is not permitted, regardless of
artifact equality. A miss is false only when the oracle establishes equivalence
and explicitly permits reuse.

## Statistical gate

For zero false hits in `n` independently sampled would-hit trials:

```text
upper95 = 1 - 0.05^(1 / n)
upper95Ppm = ceil(upper95 * 1,000,000)
```

Boundary fixtures are mandatory:

- `plan`/`observation`: 2,994 trials fail at 1,001 ppm; 2,995 pass at 1,000 ppm.
- `response`: 29,955 trials fail at 101 ppm; 29,956 pass at 100 ppm.

Curated conformance pairs are not independent trials and cannot satisfy this
gate. Any observed false hit fails the alpha even if a more general interval
would remain below the ceiling.

## Acceptance criteria

| ID   | Requirement               | Acceptance                                                                                              | Verification                             |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| IP1  | Contract isolation        | Compression manifests and intent-cache manifests are mutually invalid                                   | Cross-schema tests                       |
| IP2  | Strict payload-free input | Unknown/raw fields, duplicate keys, oversized lines, and malformed values fail before evaluation        | Parser and privacy tests                 |
| IP3  | Evidence uniqueness       | Duplicate case, trace, or quality digest prevents promotion                                             | Adversarial fixture tests                |
| IP4  | Complete coverage         | Every required difficulty/cache cell and safety scenario meets its minimum                              | Missing-cell mutation tests              |
| IP5  | Tier isolation            | One manifest contains exactly one tier and cannot authorize another                                     | Schema and mutation tests                |
| IP6  | Safety                    | False, prohibited, stale, unauthorized, cross-tenant, and forbidden-effect hits are zero                | Derived counter tests                    |
| IP7  | Statistical readiness     | Exact 2,994/2,995 and 29,955/29,956 boundaries hold                                                     | Deterministic math tests                 |
| IP8  | Quality                   | Any task-quality regression prevents promotion                                                          | Negative case tests                      |
| IP9  | Net value                 | Reusable slices pass 10% median/aggregate savings; mandatory-bypass slices stay within overhead ceiling | Weighted-slice and bypass-overhead tests |
| IP10 | Exact accounting          | Estimated usage, incomplete totals, or deployment drift prevents promotion                              | Schema and binding tests                 |
| IP11 | Honest provenance         | Report says `host-attested-unsigned`; documentation disclaims authentication                            | Snapshot tests                           |
| IP12 | Safe CLI                  | Exit `0` qualified, `2` unqualified, `1` malformed; manifest written only on `0`                        | CLI integration tests                    |
| IP13 | Plugin delivery           | Bundled plugin exposes the evaluator and contains no workspace dependency                               | Plugin smoke tests                       |
| IP14 | Package delivery          | `pnpm pack --dry-run` includes the new declarations/runtime and subpath import works                    | Package smoke test                       |

## Acceptance threshold

All critical criteria pass; format, lint, typecheck, unit, adversarial, CLI,
plugin, build, package, and production dependency-audit gates are green; no
known P0/P1 defect remains. The result may create promotion evidence but still
cannot deliver a cached value.

## Delivery

Use atomic commits on a feature branch, open a pull request, wait for all checks,
and consolidate on `main`. Do not create a tag or publish a package from this
increment.
