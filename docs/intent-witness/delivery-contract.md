# Delivery contract: IntentWitness shadow MVP

- Date: 2026-07-17
- Parent project: SemWitness
- Status: implemented alpha, shadow-only
- Schema IDs: `semwitness.dev/intent-ir/v1alpha1`,
  `semwitness.dev/normalization-witness/v1alpha1`, and
  `semwitness.dev/cache-hit-witness/v1alpha1`
- Attestation TypeURI:
  `https://github.com/aantenore/semwitness/blob/main/docs/attestations/cache-admission-passport/v0.1.md`

## Decision

Keep IntentWitness in the SemWitness repository as a separate bounded context,
not as a compression codec and not yet as a separate product. The v0.4 alpha
confirms this decision after adding exact, remote, and consensus compiler seams.
It shares SemWitness's provider-neutral policy, witness, replay, and host-integration
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

Determine whether differently worded requests can compile into the same typed,
canonical Intent IR and therefore identify potentially reusable work without
unsafe semantic authority. The mechanical core accepts caller-produced evidence;
Normalizer Lab now supplies an exact-alias baseline, an optional
OpenAI-compatible candidate compiler, and an all-agree consensus wrapper.
Compilers propose operation IDs only. The strict host registry owns the frame
and effect, and entity/context resolution remains external. Every decision is
shadow-only (`applied: false`), so the host's ordinary uncached path remains
authoritative.

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
- Keep the exact-alias compiler as the offline CLI default.
- Export `ConsensusIntentCompiler` from `semwitness/intent`; require `all-agree`
  across two to eight distinct compiler manifests sharing one ontology, and
  bypass on disagreement, ambiguity, member failure, malformed output, or
  abort.
- Export the optional remote adapter from
  `semwitness/intent/openai-compatible`. It may propose only a registry operation
  ID and must bind provider/model config, registry, prompt, output schema, and
  execution policy digests.
- Restrict remote transport to the configured origin and resolved
  `chat/completions` path, deny redirects, bound deadline and body size, disable
  retries/tools/telemetry, and load credentials only from an explicitly named
  `SEMWITNESS_*` environment variable.
- Require a digest-bound `maxPromptBytes` policy that caps the combined system
  instructions, operation catalog, locale, and source text before credential
  resolution or network access.
- Permit only the optional OpenAI-compatible `reasoningEffort` values `none`,
  `minimal`, `low`, `medium`, `high`, and `xhigh`; digest-bind and forward the
  exact value without substitution, preserving the provider default when absent
  and bypassing on provider rejection or returned reasoning.
- Treat the selected fixture source as explicit provider disclosure. Keep remote
  reports content-free; shadow mode still cannot authorize or serve a cache hit.
- Require `--compiler-config` and `--allow-network` together in the CLI. Before
  constructing the compiler, calculate selected fixture cases × runs and reject
  work above the bounded `--max-requests` budget (default 100).
- Derive a deterministic in-toto Passport Statement from one parsed shadow
  qualification without accepting caller-supplied issuer, approval, policy,
  timestamp, or authorization facts.
- Emit both qualification and Statement files as their exact canonical UTF-8
  bytes without a trailing line feed, so the subject and payload digests are
  reproducible from the artifacts themselves.
- Keep the Passport structurally `authentication: none`,
  `decision: shadow-qualified`, and `activationCeiling: shadow-only`; binding
  verification may return only `bound` and content-free digests. Bounded
  in-toto extensions may parse monotonically, but their presence must make the
  stricter content-free binding false.
- Distinguish the extension-eliding `canonicalProfileDigest` from the exact
  supplied-byte `payloadDigest`; only the latter may identify an exact received,
  signed, or transparency-bound payload.
- Ship Passport creation and binding inspection through the package export,
  Node CLI, and bundled Codex plugin with bounded parsing and private
  no-clobber file output. Creation stdout is a receipt only and never echoes the
  Statement or its stable scope HMACs.
- Derive one Cache Admission Decision Statement only from an exact canonical
  Passport, exact canonical eligible `CacheHitWitness`, separate qualification,
  normalization witness, operation binding, entry-source binding, exact private
  value, and deployment HMAC secret.
- Require exact cross-links for qualification, normalizer, ontology, operation
  registry, planner, tool registry, intent, shared namespace/tenant scope,
  policies, entry, and value; retain full dependency and deployment-scope
  digests as explicitly qualification-declared fields because the hit witness
  does not carry them. Recompute the cache key and domain-separated entry/value
  commitments rather than accepting them from the caller.
- Keep the Decision Statement structurally `authentication: none`,
  `mode: shadow`, `applied: false`, `activationCeiling: shadow-only`, and
  `servingAuthority: none`; v0.1 must not imply clock, revocation, current
  authorization, replay, issuer, signer, or approval enforcement.
- Ship Decision creation and exact-byte inspection through the package export,
  Node CLI, and bundled Codex plugin. Secrets and values remain private;
  Statement output is `0600`/no-clobber on POSIX, while Windows deployments
  provide an owner-restricted parent-directory DACL. Stdout is content-free.

Should, after the current alpha:

- Expand domain-specific entity, unit, temporal, and context resolvers behind
  the same schema and evidence contract.
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

- Authoritative entity resolution, vector lookup, or a distributed cache
  implementation.
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

| ID   | Requirement               | Acceptance                                                                                                                                                                                                                                                                         | Verification                                       |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| IW1  | Independent contract      | IR, normalization witness, and cache-hit witness use the three declared `v1alpha1` schema IDs and their own reason-code namespace; no codec ID participates                                                                                                                        | Schema and architecture review                     |
| IW2  | Deterministic IR          | The same valid caller-supplied Intent IR produces the same canonical IR digest                                                                                                                                                                                                     | Repeated property tests across supported platforms |
| IW3  | Candidate boundary        | The core never treats compiler inference as authority; it binds the proposed operation/frame to registry, normalizer, ontology, source, and policy evidence                                                                                                                        | API and negative tests                             |
| IW4  | Normalizer gate           | Before any compiler is promoted, positive paraphrases must converge and negation, quantifier, entity, unit, time, permission, locale, format, or effect near-misses must not                                                                                                       | External held-out and adversarial replay           |
| IW5  | Candidate-only embeddings | Adding or changing optional caller-supplied embedding/similarity evidence cannot convert a hard-gate rejection into an eligible shadow decision                                                                                                                                    | Metamorphic tests                                  |
| IW6  | Exact admission           | An eligible shadow decision requires the exact canonical IR digest and successful scope/auth/freshness/policy/effect/dependency gates                                                                                                                                              | Unit, property, and mutation tests                 |
| IW7  | Tier isolation            | Entry and lookup require an exact tier binding; `plan`, `observation`, and `response` cannot be substituted                                                                                                                                                                        | Cross-tier mismatch tests                          |
| IW8  | Side-effect safety        | Observation and response hits for `write` or `irreversible` requests are exactly zero                                                                                                                                                                                              | Exhaustive policy tests and shadow telemetry       |
| IW9  | Isolation                 | Cross-tenant and unauthorized hits are exactly zero                                                                                                                                                                                                                                | Adversarial multi-tenant replay                    |
| IW10 | Freshness                 | Stale observation and response hits are exactly zero under a deterministic test clock                                                                                                                                                                                              | Boundary, clock-skew, and source-version tests     |
| IW11 | Shadow honesty            | Every decision has `applied: false`; the library returns evidence, not a cached value, and host integration keeps the ordinary path authoritative                                                                                                                                  | API and integration trace assertions               |
| IW12 | Fail closed               | Malformed, missing, unsupported, tampered, or mismatched evidence is rejected with a structured error or an `applied: false` bypass; future adapter faults must do the same                                                                                                        | Negative tests and future fault injection          |
| IW13 | Privacy                   | Reports and default logs contain no request, response, tool result, secret, tenant name, or user identifier                                                                                                                                                                        | Snapshot tests and source scans                    |
| IW14 | False-hit bound           | The one-sided 95% upper confidence bound is at most `0.001` for eligible plan/observation would-hits and at most `0.0001` for response would-hits, with zero observed response false hits                                                                                          | Independent held-out evaluation                    |
| IW15 | Net value                 | Savings and latency estimates include compiler, embedding, lookup, verifier, miss, shadow comparison, invalidation, and recovery costs                                                                                                                                             | Provider-observed workload report                  |
| IW16 | Registry authority        | Compiler output can propose only an operation ID; the trusted registry owns goal, effect, and the typed frame, and unknown operations bypass                                                                                                                                       | API, malformed-adapter, and effect tests           |
| IW17 | Deterministic baseline    | Explicit locale + alias rules converge under bounded lexical normalization; punctuation, negation, quantities, and unseen text are not fuzzily removed                                                                                                                             | Exact-alias and adversarial tests                  |
| IW18 | Split-safe fixture        | Case families and explicit equivalent/distinct comparisons cannot cross splits or contradict canonical ground truth                                                                                                                                                                | Strict JSONL parser tests                          |
| IW19 | Multi-dimensional report  | Evaluation reports exact accuracy, bypasses, unsafe accepts, repeatability, convergence, false merges, per-phenomenon rates, and statistical readiness separately                                                                                                                  | Evaluator and CLI snapshots                        |
| IW20 | No live promotion         | Every normalizer report is content-free, sets `activeCacheQualified: false`, and exposes no CLI or SDK cache-value serving path                                                                                                                                                    | Privacy and public API tests                       |
| IW21 | Remote compiler boundary  | The OpenAI-compatible adapter emits operation proposals only; the registry owns Intent IR/effect, all prompt/output/config bindings including optional reasoning effort are digest-bound, and transport/retry/tool/telemetry/reasoning restrictions fail closed                    | Adapter and adversarial transport tests            |
| IW22 | Consensus fail-closed     | Two to eight distinct-manifest members with one ontology must all return the same valid unambiguous operation; every mixed, failed, bypassed, malformed, or aborted outcome bypasses                                                                                               | Consensus unit and mutation tests                  |
| IW23 | Explicit network budget   | Network evaluation requires config plus opt-in, rejects unknown/secret-valued bindings, and checks selected cases × runs against the request budget before compiler construction                                                                                                   | CLI mocked-network tests                           |
| IW24 | Curated corpus accounting | The checked-in corpus contains exactly 96 intent cases, 24 safety bypasses, 48 equivalent pairs, and 96 distinct pairs, while reports label all pair statistics non-IID                                                                                                            | Corpus invariant and report tests                  |
| IW25 | Passport derivation       | One exact canonical qualification file produces byte-deterministic in-toto Statement v1 output with no trailing LF; its single subject and every predicate field are derived from that manifest                                                                                    | Golden, mutation, file-digest, and binding tests   |
| IW26 | Passport honesty          | The Statement and API expose no issuer, approval, live/canary decision, candidate, value, or serving path; authentication remains none and activation ceiling remains shadow-only                                                                                                  | Public API, JSON, and privacy snapshots            |
| IW27 | Passport boundary         | Strict bounded JSON rejects ambiguity and data-bearing object tricks; monotonic extensions parse but always produce `extensionsPresent: true` and `bound: false` under the content-free policy                                                                                     | Parser, Proxy/accessor, and extension tests        |
| IW28 | Passport delivery         | Installed package and isolated Codex plugin execute `intent passport create/inspect`; files are private/no-clobber, creation stdout is receipt-only, and CLI exit `0/2/1` remains stable                                                                                           | Pack-install, plugin, and CLI integration tests    |
| IW29 | Passport byte identity    | RFC 3339 validity is canonical; `payloadDigest` commits exact supplied bytes while `canonicalProfileDigest` identifies only the extension-eliding supported profile; non-canonical byte payloads never bind                                                                        | Timestamp, extension, and exact-byte tests         |
| IW30 | Decision derivation       | One exact Passport plus one exact eligible CacheHitWitness produce byte-deterministic two-subject in-toto Statement output; every predicate field is derived from separately verified evidence                                                                                     | Golden, subject, and cross-link mutation tests     |
| IW31 | Decision commitments      | Cache key and entry/value commitments are recomputed with bounded deployment secret input and separate HMAC domains; public entry/value SHA fields, raw source, and raw value are absent                                                                                           | Golden HMAC, substitution, and privacy tests       |
| IW32 | Decision byte identity    | `profileBound` reports supported-profile equality, but `bound` additionally requires exact canonical Statement bytes and no extensions; object-only input can never be byte-bound                                                                                                  | Canonical, object, extension, and tamper tests     |
| IW33 | Decision honesty          | Authentication, mode, applied state, ceiling, and serving authority are fixed; docs and API explicitly deny clock, revocation, current authorization, replay, and active-serving claims                                                                                            | Invariant, public API, docs, and threat review     |
| IW34 | Decision delivery         | Installed package and isolated plugin execute `intent admission create/inspect`; env-referenced secret and exact value never reach stdout; output is `0600`/no-clobber on POSIX and uses an operator-provisioned owner-restricted directory ACL on Windows; exit `0/2/1` is stable | Pack-install, plugin, CLI, and file-safety tests   |

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

Normalizer Lab now evaluates 120 checked-in cases: 96 positive intent cases
across 12 semantic families and 24 safety bypasses. Its 48 equivalent pairs
cover each positive case once; its 96 distinct pairs cover each positive case
twice. These are curated, balanced coverage invariants—not independent trials.
The strict parser rejects family leakage across development and held-out splits.
A later end-to-end evaluation still compares at least four baselines: raw
exact-text hashing, embedding threshold alone, typed Intent IR without hard
gates, and full IntentWitness admission. Splits remain by semantic family rather
than random utterance so paraphrases of one intent cannot leak across
train/tuning and test sets.

Normalizer Lab treats explicit fixture pairs as curated, potentially correlated
comparisons. Its automatic bound is therefore always `null` and statistical
readiness remains false. Only an independent evaluation with an attested IID (or
otherwise justified) sampling protocol may apply the predeclared confidence
method required by IW14. Passing a small conformance fixture does not satisfy
IW14 or qualify an active cache.

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
