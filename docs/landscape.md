# SemWitness: competitive landscape

_Research snapshot: 2026-07-15. Sources are the projects' public repositories and official registries._

## Positioning

SemWitness is not another compression algorithm. It is a **proof-carrying compression control plane** for AI-agent context: policy selects a replaceable codec for each typed segment, every transformation emits a machine-verifiable witness, and active rewriting is gated by shadow evaluation and deterministic replay.

The v0.1 witness binds the original and projected content hashes to a segment-metadata digest, policy and codec versions, protected anchors, token evidence, and a decision or bypass reason. This makes mechanical compression evidence reviewable and fail-safe: if an implemented invariant cannot be proved, SemWitness preserves the original. Cache impact and task-level replay results deliberately remain external evidence rather than unsupported witness claims.

## Adjacent projects

| Project                                                           | What its primary documentation establishes                                                                                                                                                     | SemWitness boundary                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RTK](https://github.com/rtk-ai/rtk)                              | A Rust CLI proxy that rewrites common development commands and filters, groups, truncates, or deduplicates their output before it reaches an agent.                                            | Valuable tool-output optimization, but its public README does not define a portable per-transformation witness, typed protection policy, or deterministic corpus-replay gate.                                 |
| [Headroom](https://github.com/headroomlabs-ai/headroom)           | A library, API proxy, and MCP server with content routing, AST/JSON/prose compressors, reversible CCR retrieval, CacheAligner, and live-zone compression that preserves frozen cache prefixes. | The closest API-layer platform. SemWitness focuses on independently verifiable evidence and policy conformance across replaceable codecs rather than owning the compression models or proxy path.             |
| [LLMLingua](https://github.com/microsoft/LLMLingua)               | Neural prompt-compression methods that remove non-essential tokens; structured tags can apply different rates or preserve selected sections.                                                   | A potential codec adapter. It does not position itself as host integration, policy governance, or proof/replay infrastructure.                                                                                |
| [Squeez](https://github.com/claudioemmanuel/squeez)               | Multi-host CLI hooks, command-output and prompt compression, content-addressed recovery of originals, identifier preservation, a net-win gate, and cache-aware savings accounting.             | The closest hook-layer implementation. SemWitness must add value through a stable witness schema, explicit segment policies, deterministic replay, and cross-codec conformance—not by repeating hook filters. |
| [Token Optimizer](https://github.com/alexgreensh/token-optimizer) | Audits structural, runtime, and behavioural token waste; provides compression hooks, cache and quality metrics, compaction recovery, and shadow switches for selected features.                | The closest operational-observability product. SemWitness makes shadow/replay the admission protocol for every transform and produces portable evidence that another process can verify.                      |

The features above overlap substantially. “Content-aware”, “reversible”, “cache-aware”, “measured”, and “shadow mode” are therefore not standalone differentiators. The defensible gap is their combination as an open verification contract:

1. classify input into typed segments and apply declarative protection policies;
2. dispatch only to explicitly registered, replaceable codec adapters;
3. emit a canonical witness for compression, passthrough, or rejection;
4. verify hashes, anchors, schemas, and configured byte/token budgets without calling an LLM;
5. replay recorded corpora deterministically as mechanical input to an external policy-admission decision;
6. default to shadow mode and preserve the original on uncertainty or net loss;
7. integrate with Codex first while keeping the host boundary adaptable to Claude and others.

This positions SemWitness as **compression CI and governance**, while RTK and Squeez optimize CLI surfaces, Headroom supplies a compression platform, LLMLingua supplies neural codecs, and Token Optimizer supplies broader context operations.

## Preliminary name screening

The exact `SemWitness` name returned no repository in the [GitHub repository search](https://github.com/search?q=SemWitness+in%3Aname&type=repositories), no visible account at [`github.com/SemWitness`](https://github.com/SemWitness), and no package record from the [npm registry](https://registry.npmjs.org/semwitness) when checked. The [Verisign `.com` RDAP endpoint](https://rdap.verisign.com/com/v1/domain/SEMWITNESS.COM) returned no domain record, and DNS resolution also returned no address at the time of the check.

These are availability signals, not reservations or legal conclusions. A 404 can also reflect registry policy, a reserved identifier, propagation delay, or an unavailable registration path. Exact-name checks do not cover confusingly similar marks, unindexed filings, every jurisdiction, or every product class. The USPTO provides an official [Trademark Search](https://tmsearch.uspto.gov/search/) interface, while WIPO states that its [Global Brand Database](https://www.wipo.int/en/web/global-brand-database) is only a starting point and recommends national or regional register searches; WIPO also explains that a missing result does not establish availability in its [FAQ](https://www.wipo.int/en/web/global-brand-database/faqs_branddb).

Two alternatives have clearer collisions: `AnchorZip` is an existing [Tritech product](https://www.tritech.co.uk/products/anchorzip-10), and `ProofPress` is an active [AI journalism and content-verification platform](https://proofpress.ai/) with an occupied [GitHub account](https://github.com/proofpress). `TokenWitness` and `ContextWitness` had no exact GitHub or npm package matches, but their `.com` names already had registry records ([TokenWitness RDAP](https://rdap.verisign.com/com/v1/domain/TOKENWITNESS.COM), [ContextWitness RDAP](https://rdap.verisign.com/com/v1/domain/CONTEXTWITNESS.COM)).

Before a public launch or trademark filing, repeat the exact and similarity searches in the target jurisdictions and relevant software/service classes, then obtain professional clearance if the brand will carry commercial value.
