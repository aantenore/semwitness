# Delivery contract: Compact Response

- Date: 2026-07-17
- Target release: `v0.6.0-alpha.1`
- Maturity: experimental, local-first protocol
- Delivery mode: pull request, prerelease only after all required CI is green

## Outcome

SemWitness will expose an additive `semwitness/response` boundary for LLMs that
generate a small, schema-bound intermediate representation instead of verbose
presentation text. A host-controlled, digest-bound renderer expands that
candidate locally and emits a content-free witness. This can reduce provider
output only when the model is instructed to generate the compact candidate in
the first place; transforming an already generated answer remains out of
scope.

## Scope

### Must

- Parse contracts and candidates as strict UTF-8 JSON with duplicate-key,
  depth, item, string, byte, and exact-number limits.
- Support a deliberately small schema dialect: scalar types, enums, closed
  objects, homogeneous arrays, bounded tuples, and numeric/string/array bounds.
- Reject unknown contract, schema, witness, and candidate fields wherever the
  contract closes an object.
- Bind the exact contract, candidate bytes, renderer ID/version/artifact
  digest, rendered bytes, media type, and optional local token projection into
  a deterministic witness.
- Snapshot registered renderers and caller bytes before asynchronous work.
- Return only `rendered` or `retry-required`; failure must never expose the raw
  candidate, partial output, or an unverified rendering.
- Enforce the whole render deadline and output-size limit. Cooperative renderer
  cancellation is signalled through `AbortSignal`.
- Keep token accounting honest: the witness may contain a local projection,
  while `billedOutputSavings` remains `null` until provider usage is observed.
- Ship a deterministic English change-report renderer, example contract,
  example candidate, CLI inspect/render/verify/replay workflows, and the same
  runtime in the Codex plugin bundle.
- Preserve existing compression, intent, host, and AI SDK exports unchanged.

### Should

- Keep the response domain independent from IntentWitness. IntentABI may bind
  an `outputContractDigest`, but SemWitness remains the parser, renderer, and
  witness authority.
- Make renderer registration replaceable and provider-neutral.
- Keep every report content-free: digests, bounded counters, stable reason
  codes, and renderer metadata only.

### Out of scope

- Prompt interception, provider calls, model selection, or automatic retry.
- Compressing text after it has already been billed as model output.
- Proving semantic correctness of values selected by a model.
- Arbitrary JSON Schema, regular expressions, references, executable contract
  extensions, templates supplied by untrusted callers, or dynamic imports.
- Streaming expansion, HTML rendering, active response caching, signing,
  authentication, or serving authority.
- Hard cancellation of synchronous CPU-bound renderer code; hosts that load
  third-party renderers must isolate them in a worker or process.

## Requirements and acceptance

| ID   | Requirement             | Acceptance evidence                                                                                                                  |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CR1  | Strict contract parsing | Unknown fields, duplicate keys, unsafe numbers, malformed Unicode, oversized schemas, and unsupported dialect features are rejected. |
| CR2  | Candidate validation    | Closed-object, tuple, enum, scalar, global-depth, item, byte, and string limits fail before renderer invocation.                     |
| CR3  | Renderer binding        | Missing, duplicate, version-skewed, digest-skewed, media-type-skewed, or locale-skewed renderers fail closed.                        |
| CR4  | Atomic execution        | Timeout, throw, abort, invalid Unicode, and output expansion return only bounded `retry-required` reasons and no output.             |
| CR5  | Deterministic witness   | Identical contract, exact candidate bytes, renderer, tokenizer, and output produce identical witness bytes and digest.               |
| CR6  | Replay verification     | Candidate, contract, renderer, output, witness, tokenizer, and any digest/length tampering are detected.                             |
| CR7  | Privacy                 | Witnesses, receipts, errors, and default logs contain no candidate or rendered content.                                              |
| CR8  | Honest accounting       | Local exact/heuristic token projection is labelled; provider-billed savings are never inferred.                                      |
| CR9  | Demonstrable profile    | The checked-in compact change report renders to deterministic Markdown with safe escaping.                                           |
| CR10 | Delivery                | Format, lint, typecheck, tests, build, package dry-run, plugin isolation, dependency audit, and cross-platform CI pass.              |

## Public API

```ts
import {
  createCompactResponseRuntime,
  digestCompactResponseContract,
  parseCompactResponseContract,
  renderCompactResponseCandidate,
  verifyCompactResponseWitness,
} from 'semwitness/response';
```

The runtime receives a fixed renderer registry and optional tokenizer. Candidate
input remains strict JSON bytes or text, never an arbitrary JavaScript object.

## Rollout gate

The v0.6 alpha proves deterministic local rendering and evidence binding only.
Any production promotion of a later SDK/App Server adapter requires at least
50 held-out counterbalanced cases, exact provider usage,
retry/refusal/truncation accounting, zero task regressions, and at least 10%
net output-token benefit before any production claim. Until then the feature
and every adapter remain explicit, experimental, and opt-in.

## Rollback

The package export and CLI command group are additive. Rollback removes the
host instruction that asks the model for the compact contract; the provider can
return its normal response without data migration or cache invalidation.
