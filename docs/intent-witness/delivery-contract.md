# Delivery contract: IntentWitness shadow MVP

- Date: 2026-07-15
- Parent project: SemWitness
- Status: proposed, shadow-only
- Schema IDs: `semwitness.dev/intent-ir/v1alpha1`,
  `semwitness.dev/normalization-witness/v1alpha1`, and
  `semwitness.dev/cache-hit-witness/v1alpha1`

## Decision

Build IntentWitness in the SemWitness repository as a separate bounded context,
not as a compression codec and not yet as a separate product. It shares
SemWitness's provider-neutral policy, witness, replay, and host-integration
principles, while keeping independent schemas, versions, reason codes, and
promotion gates.

This is a reversible packaging decision. Split IntentWitness into a separate
repository only when at least one of these conditions is demonstrated:

- it needs a release cadence or runtime that cannot remain compatible with the
  SemWitness core;
- consumers adopt intent admission without any compression capability;
- its evaluation corpora, service footprint, or governance become operationally
  independent;
- repository coupling measurably slows releases or creates dependency cycles.

Until then, a second repository would duplicate policy, security, evaluation,
and integration work before the core hypothesis has been validated.

## Objective

Determine whether differently worded requests can eventually be compiled into
the same typed, canonical Intent IR and therefore share cached work without
unsafe semantic guessing. The first mechanical increment accepts a
caller-supplied Intent IR candidate plus normalization evidence; it validates,
canonicalizes, and evaluates that candidate but does not yet parse natural
language or resolve entities. Every decision is shadow-only (`applied: false`),
so the host's ordinary uncached path remains authoritative.

The product hypothesis is stronger than an embedding-similarity cache:

> Embeddings may find candidates; only an exact canonical Intent IR digest plus
> scope, authorization, freshness, policy, effect, and dependency gates may
> produce a would-hit.

IntentWitness does not claim to prove universal natural-language equivalence.
It emits reviewable evidence for a bounded normalization and an explicit cache
admission decision.

## Scope

Must:

- Define `semwitness.dev/intent-ir/v1alpha1`,
  `semwitness.dev/normalization-witness/v1alpha1`, and
  `semwitness.dev/cache-hit-witness/v1alpha1` as independent, strict, versioned
  schemas. None is a SemWitness codec or codec configuration.
- Accept a caller-supplied Intent IR candidate, source digest, normalizer and
  ontology bindings, policy digest, ambiguity/confidence assessment, and
  optional non-authoritative candidate evidence.
- Canonicalize the validated IR deterministically and use its exact canonical
  digest for equality. Missing and explicit values must remain distinguishable.
- Treat embeddings, vector search, reranking, and LLM judgments only as
  candidate-generation inputs. No similarity score or model verdict may admit a
  cache hit.
- Apply mandatory tenant/scope, authorization, freshness, policy, effect, and
  dependency gates after canonical IR equality.
- Separate `plan`, `observation`, and `response` cache tiers and bind each tier
  to its own dependency vector. `observation` represents a read-only tool or
  data result.
- Prohibit observation and response reuse for `write` or `irreversible`
  requests. An unrecognized effect fails schema validation. A cached plan for a
  non-read request is a non-executable template and requires fresh
  authorization, confirmation, and execution.
- Default every unknown, ambiguous, stale, malformed, unsupported, or failed
  condition to bypass.
- Run the MVP in shadow mode: record a content-free would-hit/bypass decision
  with `applied: false` and never expose an artifact-substitution API. The host
  remains responsible for its ordinary path.
- Preserve the source request outside reports; evidence may contain bounded
  metadata, digests, counters, versions, and reason codes only.

Should, after the mechanical increment:

- Add deterministic natural-language compilers first and optional LLM compilers
  behind the same schema and evidence contract.
- Keep compiler, entity resolver, embedding index, authorizer, freshness
  resolver, policy engine, cache store, clock, and telemetry behind replaceable
  ports selected from allowlisted registries.
- Resolve aliases, units, locale, time expressions, and entities through
  versioned registries rather than prompt-only conventions.
- Optimize provider prefix caching separately by keeping system instructions,
  tool schemas, templates, and examples byte-stable before volatile request
  data.
- Support local in-memory or filesystem fixtures first, with Redis or another
  distributed store as an adapter rather than a core dependency.
- Produce replay reports that distinguish exact-source hits, normalized-IR
  hits, candidate rejections, and safety bypasses.

Out of scope for the shadow MVP:

- Natural-language intent compilation, entity resolution, vector lookup, or a
  distributed cache implementation in the first mechanical increment.
- Serving any cached plan, observation, or response to a user or tool.
- Executing an action from a cache entry.
- Cross-tenant reuse, even when the visible text is public or identical.
- A universal ontology, autonomous schema evolution, or learning canonical IDs
  directly from production traffic.
- Treating provider prompt/KV caching as semantic artifact caching.
- Claims that normalizing a completed model response reduces tokens already
  billed for that response.

## Tier contract

| Tier          | Artifact                                | Eligible in shadow analysis                                                                                                          | Future active-mode ceiling                                                                |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `plan`        | Non-executable route/tool plan template | `read`, `write`, or `irreversible` requests after exact IR and hard gates                                                            | May be reused only as a template; fresh authorization and all preconditions are mandatory |
| `observation` | Read-only tool or data result           | `read` requests with an unexpired TTL or an exact revision set                                                                       | Never eligible for `write`, `irreversible`, stale, or unauthorized data                   |
| `response`    | User-visible rendered answer            | `read` requests with typed deterministic, non-personalized, cache-eligible-safety attestations and exact observation/output bindings | Last tier considered for promotion; never eligible for non-read or stale data             |

The three tiers are separate records. Promotion of `plan` does not imply
promotion of `observation` or `response`.

## Acceptance criteria

| ID   | Requirement               | Acceptance                                                                                                                                                                                | Verification                                       |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| IW1  | Independent contract      | IR, normalization witness, and cache-hit witness use the three declared `v1alpha1` schema IDs and their own reason-code namespace; no codec ID participates                               | Schema and architecture review                     |
| IW2  | Deterministic IR          | The same valid caller-supplied Intent IR produces the same canonical IR digest                                                                                                            | Repeated property tests across supported platforms |
| IW3  | Candidate boundary        | The core does not infer natural language; it binds a caller-supplied candidate to normalizer, ontology, source, and policy evidence                                                       | API and negative tests                             |
| IW4  | Future normalizer gate    | Before any compiler is promoted, positive paraphrases must converge and negation, quantifier, entity, unit, time, permission, locale, format, or effect near-misses must not              | External held-out and adversarial replay           |
| IW5  | Candidate-only embeddings | Adding or changing optional caller-supplied embedding/similarity evidence cannot convert a hard-gate rejection into an eligible shadow decision                                           | Metamorphic tests                                  |
| IW6  | Exact admission           | An eligible shadow decision requires the exact canonical IR digest and successful scope/auth/freshness/policy/effect/dependency gates                                                     | Unit, property, and mutation tests                 |
| IW7  | Tier isolation            | Entry and lookup require an exact tier binding; `plan`, `observation`, and `response` cannot be substituted                                                                               | Cross-tier mismatch tests                          |
| IW8  | Side-effect safety        | Observation and response hits for `write` or `irreversible` requests are exactly zero                                                                                                     | Exhaustive policy tests and shadow telemetry       |
| IW9  | Isolation                 | Cross-tenant and unauthorized hits are exactly zero                                                                                                                                       | Adversarial multi-tenant replay                    |
| IW10 | Freshness                 | Stale observation and response hits are exactly zero under a deterministic test clock                                                                                                     | Boundary, clock-skew, and source-version tests     |
| IW11 | Shadow honesty            | Every decision has `applied: false`; the library returns evidence, not a cached value, and host integration keeps the ordinary path authoritative                                         | API and integration trace assertions               |
| IW12 | Fail closed               | Malformed, missing, unsupported, tampered, or mismatched evidence is rejected with a structured error or an `applied: false` bypass; future adapter faults must do the same               | Negative tests and future fault injection          |
| IW13 | Privacy                   | Reports and default logs contain no request, response, tool result, secret, tenant name, or user identifier                                                                               | Snapshot tests and source scans                    |
| IW14 | False-hit bound           | The one-sided 95% upper confidence bound is at most `0.001` for eligible plan/observation would-hits and at most `0.0001` for response would-hits, with zero observed response false hits | Independent held-out evaluation                    |
| IW15 | Net value                 | Savings and latency estimates include compiler, embedding, lookup, verifier, miss, shadow comparison, invalidation, and recovery costs                                                    | Provider-observed workload report                  |

`IW14` uses a predeclared binomial confidence method such as one-sided Wilson or
Clopper-Pearson. Reporting zero observed errors without enough eligible
would-hits to satisfy the bound does not pass.

## Evaluation corpus

The held-out corpus must contain:

- true paraphrase clusters, including multilingual, typo, and reordered forms;
- adversarial near-misses differing by one negation, number, unit, entity,
  quantifier, date, freshness requirement, permission, tenant, output format, or
  side effect;
- ambiguous pronouns and conversation references with both resolvable and
  unresolvable context;
- prompt-injection text embedded in entity values and tool data;
- compiler, ontology, policy, tool, data, model, and schema version changes;
- cold-cache, warm-cache, invalidation, store-fault, timeout, and clock-skew
  scenarios.

The first increment evaluates mechanical IR and admission invariants with
caller-supplied fixtures. A later end-to-end normalizer evaluation compares at
least four baselines: raw exact-text hashing, embedding threshold alone, typed
Intent IR without hard gates, and the full IntentWitness admission pipeline.
Splits are by semantic family rather than random utterance so paraphrases of the
same intent cannot leak across train/tuning and test sets.

## Promotion sequence

1. **Offline replay:** no cache store writes outside test fixtures.
2. **Shadow write:** store candidates in an isolated namespace; normal execution
   remains authoritative.
3. **Shadow would-read:** evaluate every tier and compare with normal execution.
4. **Plan canary:** considered only after all acceptance criteria pass for a
   fixed compiler/schema/policy bundle.
5. **Observation canary:** `read` and immutable or freshness-bounded workloads
   only.
6. **Response canary:** separate approval after the stricter response bound and
   zero prohibited-hit invariants pass.

Any schema, compiler, ontology, policy, authorizer, tool contract, data source,
prompt template, or model version change creates a new namespace or invalidates
the affected tier. Rollback disables reads first; bypass remains the runtime
safety state.
