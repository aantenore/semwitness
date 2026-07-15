# IntentWitness: 2026 landscape and product boundary

_Research snapshot: 2026-07-15. Claims below are limited to linked primary
documentation and public repositories._

## Decision summary

Develop IntentWitness as a distinct bounded context in the SemWitness repository
through the shadow MVP. Keep its schemas, versions, ports, reason codes, threat
model, and promotion gates independent from compression codecs. Revisit a
repository split only after independent adoption or incompatible operational
requirements emerge.

The defensible hypothesis is not "semantic cache" by itself. Mature projects
already retrieve cached answers for similar prompts. The narrower gap to test is
**proof-carrying intent normalization**:

1. accept and verify a strict, versioned Intent IR, then add replaceable
   compilers only after the mechanical contract is stable;
2. use embeddings only to propose operations, entities, or records;
3. require an exact canonical IR digest match;
4. re-check tenant/scope, authorization, freshness, policy, effect, and
   tier-specific dependencies;
5. emit a replayable admission witness and remain shadow-only until statistical
   and adversarial gates pass.

This is an inference from the reviewed sources, not a claim that no private,
academic, or unindexed system has ever implemented the same combination.

## Provider prompt/KV caching

Provider caches reuse a prompt prefix during model prefill. They do not infer
that two differently worded requests have the same application intent, and a
hit does not skip output generation.

| Provider                                                                                         | What current primary documentation establishes                                                                                                                                                                     | IntentWitness boundary                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)            | Cache hits require exact prompt-prefix matches; static content should precede variable content. Current APIs expose cache keys, explicit breakpoints on supported models, and usage fields for cache writes/reads. | A provider adapter may stabilize prompt layout and record usage. `prompt_cache_key` is routing/cache control, not a semantic IntentWitness key and never authorizes application artifact reuse. |
| [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Cacheable prefixes are ordered through tools, system, and messages; changes before a breakpoint alter the prefix hash. Static content and explicit/automatic breakpoints improve reuse.                            | Preserve byte-stable tools/instructions independently. An Anthropic cache read remains provider-prefix telemetry, not proof that two user intents or answers are interchangeable.               |
| [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching/)                         | Current Gemini documentation recommends large common content at the beginning and requests with similar prefixes, and exposes cached-token usage.                                                                  | "Similar prefix" is provider behavior, not the application equivalence contract. IntentWitness relies on its own exact canonical IR and hard gates.                                             |

These mechanisms are complementary. A normalized application request may also
make a provider request more stable, but application-cache savings and
provider-prefix savings must be measured separately to avoid double counting.

## Application semantic caching and routing

| Project                                                                               | What its primary documentation establishes                                                                                                                                                                                                                                                                   | Gap tested by IntentWitness                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RedisVL `SemanticCache`](https://redis.io/docs/latest/develop/ai/redisvl/api/cache/) | Retrieves cached LLM responses using prompt/vector similarity, a configurable distance threshold, TTL, and optional filters. Redis also documents semantic caching of LLM responses and tool results.                                                                                                        | Use RedisVL as a possible `CandidateIndex` or `TierStore`, not as the admission authority. A distance threshold proposes a candidate; exact canonical IR, scope/auth/freshness/policy/effect, and dependency gates decide. |
| [GPTCache](https://github.com/zilliztech/GPTCache)                                    | Provides modular adapters, embeddings, vector stores, similarity evaluators, storage, and exact or semantic cache paths; its README explicitly acknowledges false positives and false negatives. The repository also states it no longer adds new model/API adapters and recommends its generic get/set API. | Reuse its architectural lessons, but test a stricter typed admission contract and uncertainty bound instead of treating similarity evaluation as sufficient to return a response.                                          |
| [Semantic Router](https://github.com/aurelio-labs/semantic-router)                    | Uses vector-space similarity to choose predefined routes and can return no route when no match exists. It is a fast decision layer for tool/agent routing, not primarily an answer cache.                                                                                                                    | It can inspire or implement operation candidate generation. Route equality alone does not establish identical arguments, authority, freshness, effects, dependencies, or reusable output.                                  |

The reviewed systems are valuable adapters and baselines, not targets to clone.
IntentWitness should integrate established vector stores and routers through
ports instead of implementing another vector database or embedding framework.

## Why typed normalization changes the cache model

An embedding cache asks whether two texts are close in a learned vector space.
IntentWitness asks whether a versioned normalizer resolved both requests to the
same explicit goal and answer-affecting slots. The first increment accepts that
candidate IR and its evidence from the caller; it does not yet implement the
normalizer.

For example:

| Pair                                                               | Topic similarity      | Required IntentWitness decision                                                                              |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| "Come configuro Redis?" / "Mi spieghi la configurazione di Redis?" | High                  | May converge only when version, audience, depth, locale, format, context, and freshness contracts also match |
| "Elimina il repository X" / "Non eliminare il repository X"        | High                  | Different IR because polarity/effect differs; observation and response tiers structurally prohibited         |
| "Prezzo BTC adesso" / "Prezzo BTC ieri alle 12"                    | High                  | Different absolute temporal constraints and source snapshots; no stale reuse                                 |
| "Mostra i miei ticket" for users A and B                           | Nearly identical text | Separate tenant/principal scope; cross-user artifact reuse prohibited                                        |

A future normalizer therefore needs an ontology/operation registry, entity and
temporal resolution, explicit output contract, effect classification, and
immutable context bindings. Embeddings improve recall before that boundary;
they do not weaken it.

## Competitive posture

Do not position IntentWitness as:

- a general-purpose vector cache;
- a replacement for Redis, RedisVL, GPTCache, or Semantic Router;
- a provider prompt-cache abstraction;
- mathematical proof of natural-language meaning;
- a promise of savings before shadow evaluation.

Position it as:

> A provider-neutral admission and evidence layer that verifies a versioned
> Intent IR, exact semantic-key equality, and host-supplied current
> security/freshness bindings, then evaluates tiered agent-cache reuse before
> production. Replaceable
> normalizers are the next layer, not an MVP overclaim.

The strongest initial customer surface is likely agent infrastructure rather
than generic chat: repeated routing, planning, read-only tool calls, and
structured answers expose clear operation schemas and dependencies. The first
promotion target should be non-executable plan templates, then immutable or
freshness-bounded read-only observations/tool results. Response reuse remains
last.

## Build-versus-integrate choices

| Capability                            | Recommendation                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Vector search and distributed storage | Integrate RedisVL/Redis or another adapter; do not build a database                                          |
| Semantic routing                      | Support Semantic Router or equivalent behind `CandidateIndex`; retain independent admission                  |
| Exact canonical store                 | Implement the small provider-neutral contract and conformance fixtures; allow multiple storage adapters      |
| Intent/operation schemas              | Build and version as the core product IP; configuration selects reviewed registries                          |
| Entity, unit, and time resolution     | Integrate mature resolvers behind typed ports; never let free-form model output be authority                 |
| Authorization and freshness           | Call host-owned authoritative systems on every read; do not recreate identity or source-of-truth systems     |
| Provider prefix caching               | Thin measurement/layout adapters only; follow each provider's official semantics                             |
| Statistical evaluation                | Build a project-specific replay and promotion harness because safety claims depend on the exact IR and gates |

## Validation questions before a repository split

Shadow evidence should answer:

1. Does typed IR produce materially more safe paraphrase hits than raw exact
   hashing after compiler cost?
2. Does it materially reduce false hits versus an embedding threshold baseline?
3. Which tier creates value: plan, read-only observation, or response?
4. Can the strict false-hit upper bounds be demonstrated with realistic sample
   sizes, not only zero observed failures?
5. Do users want IntentWitness without SemWitness's compression governance?
6. Does a separate runtime/service become necessary for model-based compilers or
   distributed stores?

If the answer to the first four is negative, the project should remain a
research module or be removed. If they are positive and the last two are also
positive, a clean repository split becomes justified because the schemas and
ports are already isolated.
