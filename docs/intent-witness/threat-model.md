# IntentWitness threat model

_Shadow MVP design baseline — 2026-07-15_

## Scope and security objective

IntentWitness's first mechanical increment validates a caller-supplied canonical
Intent IR candidate, examines caller-supplied tier bindings, and emits
normalization and cache-hit witnesses. Natural-language compilation, entity
resolution, vector lookup, and authoritative host adapters are future work. The
core does not serve cache values, and every MVP decision sets `applied: false`.

The primary security objective is to prevent a semantic collision, stale state,
authorization drift, tenant confusion, or side-effect replay from being
misrepresented as a safe cache hit. Uncertainty must reduce reuse, never relax a
gate.

### Assets

- Raw requests, resolved entities, conversation bindings, tool results, cached
  responses, and any secrets or personal data they contain.
- Tenant, application, principal, role, authorization, and cache-scope identity.
- Intent IR schemas, operation schemas, canonicalization rules, policies,
  ontologies, compilers, prompts, models, tools, data sources, and versions.
- Plan, observation/tool-result, and response cache records and indexes.
- Freshness attestations, reference clocks, source versions, and invalidation
  events.
- Witnesses, evaluation corpora, labels, promotion decisions, and telemetry.

### Trust boundaries

1. **User to host:** free-form text and attached content are untrusted. Text that
   claims a tenant, permission, time, effect, or schema has no authority.
2. **Host/caller to IR validator:** the IR candidate, normalizer assessment, and
   all scope/dependency digests are untrusted until strict validation and exact
   comparison succeed. The first increment does not derive them from text.
3. **Future compiler/resolvers to IR validator:** proposed goals, slots,
   entities, defaults, and confidence remain untrusted even after those adapters
   exist.
4. **Candidate evidence to admission:** embeddings, similarity scores, and
   neighbors are hints supplied as `authoritative: false`. They cannot grant
   equality or authorization.
5. **Store to verifier:** cache records, timestamps, digests, and witnesses may
   be corrupted or attacker-controlled and are independently recomputed.
6. **Host authorizer/data source to admission:** the trusted host must derive
   current normalizer, HMAC-bound scope/authorization/context, dependency, and
   freshness bindings from authoritative systems. The core validates the
   supplied evidence and verifies exact equality, TTL, or revisions; it does
   not call those systems in the first increment.
7. **IntentWitness to host:** a shadow would-hit is telemetry, not permission to
   skip execution or return an artifact.
8. **Host to provider:** provider prompt/KV caching is a separate mechanism with
   provider-defined prefix and retention semantics.

### Assumptions

- The process runtime, reviewed release, allowlisted adapters, and privileged
  host identity channel are trusted at startup.
- Cryptographic hashes used by the selected contract remain collision
  resistant. Unkeyed hashes provide integrity/equality, not confidentiality or
  producer identity.
- The host can supply current HMAC-bound cache namespace, tenant, principal,
  authorization, and context digests. If not, admission must not be invoked as
  eligible.
- Time-sensitive sources can provide an immutable version, authenticated
  invalidation, or bounded freshness evidence. If not, observation/response
  reuse is unavailable.
- A host integration preserves the ordinary execution path. The core's
  `applied: false` evidence cannot enforce a malicious wrapper's behavior.

## Security invariants

1. Embedding similarity, route membership, nearest-neighbor rank, or an LLM
   equivalence judgment is never sufficient for a would-hit.
2. Every would-hit includes an exact canonical Intent IR digest match after
   strict validation and recomputation.
3. Tenant/cache scope and current authorization must match exactly; cross-tenant
   and unauthorized hits are zero.
4. Unknown or expired freshness is stale; stale observation and response hits
   are zero.
5. Observation and response hits for `write` or `irreversible` requests are
   zero; an unknown effect is invalid schema.
6. Plan, observation, and response records are tier-bound and cannot be
   substituted across tiers.
7. A cached side-effecting plan is non-executable and never carries reusable
   authorization or confirmation.
8. Missing, ambiguous, malformed, unsupported, tampered, timed-out, or
   unavailable evidence yields bypass or miss.
9. Schema, compiler, resolver, ontology, policy, tool, data, prompt, and model
   changes invalidate every tier whose dependency vector includes them.
10. Shadow decisions always carry `applied: false` and no cached value; the host
    ordinary path remains authoritative.
11. Default reports contain no source request, canonical slot values,
    observation value, response, tenant name, principal, secret, or path.
12. Provider prefix-cache events and application semantic-cache events are
    measured and reported separately.

## Threats and required controls

| Threat                            | Abuse or failure mode                                                                             | Required control                                                                                                                               | Residual risk                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic collision                | Two requests compile to one IR although their correct behavior differs                            | Typed IR; explicit polarity, slots, constraints, temporal/output/effect fields; adversarial near-miss corpus; exact canonical digest           | An ontology or future compiler can still omit a previously unknown answer-affecting distinction; shadow labels and versioned schema evolution remain necessary |
| False confidence                  | A model emits high confidence for an incorrect normalization                                      | Confidence is diagnostic only; strict schema, authoritative resolution, exact equality, and hard gates remain mandatory                        | All required slots can be confidently wrong if the operation schema itself is incomplete                                                                       |
| Negation or quantifier loss       | "Do not delete", "all", "at least", or numeric bounds collapse into a positive/general request    | First-class operators and quantities; no stop-word deletion; pairwise negative tests                                                           | Natural language can encode implicit scope that a bounded schema does not capture                                                                              |
| Entity alias collision            | Two people, repositories, accounts, or resources share a name                                     | Authoritative typed IDs, namespace and tenant binding, ambiguity bypass                                                                        | Upstream identity data can be stale or incorrect                                                                                                               |
| Unit/locale ambiguity             | Decimal separators, currencies, dates, or measurements normalize incorrectly                      | Explicit output locale and temporal shape; strict finite JSON numbers; ambiguity bypass; future typed unit conventions                         | Incorrect authoritative locale metadata can still mislead resolution                                                                                           |
| Coreference confusion             | "Do it again" or "that repo" binds to the wrong conversation object                               | Bind immutable context digest and type; bypass unresolved or mutable references                                                                | A host may provide the wrong conversation state as authoritative                                                                                               |
| Temporal drift                    | Relative time is normalized against the wrong clock; a once-valid answer is served later          | Injected clock/timezone; absolute normalized times; signed source version or bounded TTL; compare at read time                                 | Distributed clocks and delayed invalidations can create a bounded stale window                                                                                 |
| Cross-tenant leakage              | Similar prompts retrieve another tenant's plan, data, or answer                                   | Tenant/application scope in key and pre-query partition; exact post-read check; opaque diagnostics; isolation tests                            | Shared physical infrastructure still needs backend access control and operational hardening                                                                    |
| Authorization drift               | Permission is revoked after cache write or a prior user's authorization is replayed               | Host derives a fresh authorization scope; entry and lookup require an exact domain-separated HMAC digest; never cache bearer tokens            | Authorizer compromise or delayed revocation remains upstream risk                                                                                              |
| Side-effect replay                | Cached observation/response is mistaken for successful execution, or an action runs twice         | Structural ineligibility of observation/response for `write` and `irreversible`; plans are non-executable; fresh confirmation/auth/execution   | A malicious host can ignore the contract; active integrations require conformance tests                                                                        |
| Effect misclassification          | A write, message, payment, or external call is labelled `read`                                    | Strict `read`/`write`/`irreversible` enum; non-read only allowed for `plan`; future registry/host tool-schema cross-check                      | Incorrect caller-supplied effect metadata can still be dangerous until an authoritative host adapter owns it                                                   |
| Personalized response leak        | A general-looking request returns another user's personalized answer                              | Principal/personalization policy in dependency vector; response ineligible by default when personalization is material                         | Hidden personalization in downstream systems can be missed without inventory                                                                                   |
| Stochastic/safety-sensitive reuse | A cached response bypasses a fresh safety policy or materially different model behavior           | Response tier last; bind safety, prompt, model, and output contracts; mark safety-sensitive operations ineligible                              | Model/provider internals can change without a visible version                                                                                                  |
| Prompt injection into compiler    | Request text instructs a future compiler to forge goal, tenant, policy, or witness fields         | First increment does not compile text; future adapters treat text as data, validate structure, and take authority only out-of-band             | A future model can still misparse adversarial language, which must bypass or be found in shadow evaluation                                                     |
| Cache poisoning                   | Attacker writes crafted IR/response pairs or manipulates labels to create future hits             | Recompute canonical and entry digests; exact bound comparisons; isolated shadow namespace; future authenticated store; poisoning tests         | Compromised trusted writers or evaluation maintainers can poison data                                                                                          |
| Embedding/index poisoning         | Neighbor manipulation steers requests toward an unsafe candidate                                  | Candidate evidence is explicitly non-authoritative; exact intent and all binding gates still apply; future indexes bound candidate count       | Poisoning can cause denial of service or lower recall even when it cannot admit a hit                                                                          |
| Compiler nondeterminism           | Same request produces different IRs or paraphrases drift across model releases                    | Pin compiler/model/prompt/decoding/schema versions; deterministic adapters first; namespace changes; repeatability tests                       | Hosted model implementations can drift behind an unchanged label                                                                                               |
| Schema/policy downgrade           | Old permissive schemas or policies are replayed with new records                                  | Strict supported-version list; bind all versions/digests; no wildcard/latest keys; explicit migration without in-place mutation                | Intentional rollback must be distinguished operationally from downgrade                                                                                        |
| Canonicalization ambiguity        | Different implementations hash different bytes or ambiguous JSON parses the same text differently | Strict bounded parser; duplicate-key/Unicode/non-finite-number rejection; deterministic sorting; cross-platform fixtures                       | Cross-language implementations require conformance suites before joining one namespace                                                                         |
| Hash collision or substitution    | A record with the same digest but different IR/artifact is accepted                               | Recompute canonical IR, entry, and witness digests; domain-separated HMAC scope fields; exact bound-digest comparison                          | Cryptographic failure is unlikely but not eliminated; producer authentication is separate                                                                      |
| Dependency omission               | Tool, data, prompt, policy, or model changes but a key remains stable                             | Tier-specific dependency inventory and exact version vector; unknown dependency bypass; mutation tests                                         | Undocumented downstream dependencies can escape the inventory                                                                                                  |
| Invalidation loss                 | A source changes but its cache entries remain available                                           | Prefer immutable source versions; authenticated invalidation; short TTL fallback; fail stale on invalidation uncertainty                       | Network partitions trade availability for safety under fail-closed policy                                                                                      |
| Store tampering                   | Records, expiry, scope, or witnesses are edited or replaced                                       | Authenticate access; recompute record integrity; strict schema; immutable writes; quarantine malformed records                                 | Privileged store compromise can delete records and cause denial of service                                                                                     |
| Equality/privacy leakage          | Digests or timing reveal repeated requests, tenants, or sensitive low-entropy values              | Tenant-local namespaces; HMAC source/scope/cache keys; keyed telemetry digests; constant-shape errors; no raw values; restrict evidence access | Canonical intent and witness digests remain unkeyed integrity/equality evidence; access patterns and aggregate counts may still disclose workload shape        |
| Log/trace leakage                 | Requests, IR slots, tool results, responses, tokens, or tenant IDs enter telemetry                | Allowlisted bounded fields and reason codes; privacy snapshots; no raw errors or paths                                                         | External host/provider tracing must enforce the same redaction separately                                                                                      |
| Resource exhaustion               | Huge documents, candidate evidence, deep IR, or future adapter fan-out consumes resources         | First-increment byte/depth/item/evidence limits; future deadlines and backpressure; bypass on limit                                            | Future in-process synchronous adapters may need worker isolation for hard CPU limits                                                                           |
| Benchmark leakage/gaming          | Paraphrases cross data splits or easy repeated requests inflate hit rate                          | Split by semantic family; immutable held-out set; adversarial near-misses; independent review; report uncertainty                              | Production distributions evolve and can invalidate benchmark conclusions                                                                                       |
| Provider-cache confusion          | A provider prefix hit is counted as a semantic response hit or savings are double counted         | Separate event namespaces and cost ledgers; provider usage is authoritative; no conversion between decisions                                   | Provider billing and cache behavior can remain opaque or change over time                                                                                      |
| Shadow-to-live escalation         | A wrapper begins serving would-hit artifacts without passing promotion gates                      | No live-read API in MVP; isolated namespace; explicit future artifact and policy; integration conformance tests                                | A modified third-party host can violate the published contract                                                                                                 |

## Cache-tier abuse cases

### Plan tier

- A plan must not be executable merely because it was cached.
- Secrets, tokens, concrete authorization decisions, and prior confirmation are
  prohibited from plan records.
- Parameters are rebound from the current IR and validated against current tool
  schemas.
- Side-effecting plans require fresh authorization, confirmation, preconditions,
  idempotency strategy, and execution evidence.

### Observation / tool-result tier

- Only the `read` effect is eligible.
- Every external source requires immutable version evidence or an unexpired TTL.
- A timeout, lost invalidation channel, absent source version, or clock failure is
  stale, not "probably fresh".
- A cached observation cannot prove that a write or external action occurred.

### Response tier

- The exact observation value digest and output contract are mandatory
  dependencies in a future active adapter.
- The binding schema accepts only `deterministic`, personalization `none`, and
  safety `cache-eligible`; the trusted host must derive these attestations from
  its current policy state.
- Personalized, safety-sensitive, live-data, `write`, `irreversible`, and
  unknown-determinism responses are ineligible by default.
- A response cannot carry authorization from the request that created it.
- Promotion requires the stricter false-hit bound and an independent approval.

## Required adversarial verification

Automated and held-out tests must cover at least:

- positive paraphrases across language, word order, spelling noise, and polite
  framing;
- one-slot near-misses for negation, entity, quantity, unit, range, comparator,
  date, timezone, freshness, locale, format, tenant, permission, and effect;
- unresolved pronouns, conflicting context, stale conversation bindings, and
  mutable resource references;
- forged tenant/auth/policy/schema fields embedded in user text and tool data;
- embedding neighbors that are topically close but operationally different;
- malicious and malformed cache records, digest substitution, tier swapping,
  duplicate JSON keys, Unicode edge cases, numeric overflow, and downgrade;
- permission revocation, tenant migration, policy changes, tool/schema changes,
  data invalidation, clock skew, and network partitions;
- non-read operations mislabelled by caller/future compiler and corrected by a
  future authoritative registry or host binding;
- privacy snapshots proving payload absence from witnesses, logs, traces, and
  evaluation artifacts;
- shadow traces proving `applied: false`, absence of cached values, and an
  authoritative ordinary host path.

## Release and promotion gate

The shadow MVP is acceptable only when deterministic and adversarial suites pass
and prohibited would-hits are zero for cross-tenant, unauthorized, stale, and
non-read observation/response cases.

An active experiment additionally requires:

- a predeclared one-sided 95% false-hit upper bound of at most `0.001` for
  plan/observation and `0.0001` for response;
- zero observed response false hits and enough eligible samples to satisfy the
  response bound rather than relying on a zero numerator;
- no statistically or operationally material task-quality regression;
- positive net token, cost, or latency value after compiler, embedding, lookup,
  verification, misses, invalidation, recovery, and provider-prefix effects;
- a separate canary and rollback decision for each tier and dependency bundle.

Any cross-tenant, unauthorized, stale, or non-read observation/response hit is
a stop-ship event regardless of aggregate hit rate or savings. Rollback
disables reads and preserves bypass; it never widens similarity thresholds.
