# ADR 0001: embed the first active host adapter in SemWitness

- Status: accepted for `v0.5.0-alpha.1`
- Date: 2026-07-15

## Context

Prompt compressors, semantic response caches, LLM gateways, and intent routers
already exist. SemWitness's defensible boundary is evidence and fail-closed
admission, but its current CLI and Codex plugin are shadow-only and therefore do
not reduce a live request. The next increment must prove a real downstream token
reduction without creating another gateway or conflating intent similarity with
cache authority.

## Options considered

1. Create a separate proof-carrying gateway runtime.
2. Add normalization and reuse admission to StageFabric's placement runtime.
3. Add a provider-neutral host preparer and a thin established-SDK adapter to
   SemWitness.

## Decision

Choose option 3.

The preparer belongs with the codecs, policy, proof, CAS, and accounting whose
versions it must admit atomically. The AI SDK v4 adapter is a separate package
export and depends inward on the host boundary. SemWitness does not own the
wrapped model, provider request, credentials, retries, or routing.

The adapter computes a deployment-scope digest from its artifact version, live
provider/model identity, deployment-owned prompt/tool contract digests, and the
normalized selector/trust map. The promotion manifest must contain that exact
digest. This prevents evidence produced for one deployed contract from silently
activating another; the host remains responsible for deriving the two contract
digests from the reviewed artifacts it actually deploys.

IntentWitness remains shadow-only. Its current corpus and typed-intent proposal
pipeline do not authorize serving a cache value. StageFabric remains focused on
privacy-aware stage placement and execution.

## Decision drivers

- Produce a measurable live request transformation with the fewest new moving
  parts.
- Reuse AI SDK middleware instead of implementing an OpenAI-compatible proxy.
- Keep all active codec evidence under one versioned package and release gate.
- Avoid repository and operational sprawl before a second independent host
  exists.
- Make extraction reversible if deployment or language/runtime needs diverge.

## Consequences

- JavaScript/TypeScript hosts get the first integration path; other runtimes
  remain future adapters.
- Active behavior is deliberately narrow and requires host-owned evaluation
  attestation. The alpha does not establish cryptographic provenance for that
  manifest.
- Callers configure strict per-call scan/candidate limits and a total
  preparation deadline. Timeout or overflow forwards the exact original call
  atomically; non-cooperative work may finish later but has no request authority.
- Host proof and candidate evidence cross verifier awaits only as isolated
  copies, then private evidence is rechecked and frozen before return.
- A Codex skill/plugin can expose analysis, but transparent Codex optimization
  still requires a client built on the Codex SDK or App Server before
  `turn/start`.

## Extraction threshold

Create a separate runtime only when at least one of these becomes real:

- two or more non-JavaScript hosts need the same remote boundary;
- clients require deployment, scaling, tenancy, or release cadence independent
  from SemWitness;
- a mature gateway needs a reusable sidecar/plugin rather than an embedded
  adapter;
- the operational surface owns authentication, quotas, durable cache storage,
  or network policy.

Any extracted runtime must remain a thin adapter over an established gateway,
not a new general-purpose proxy.

## Reversal cost

Low. `semwitness/host` is provider-neutral and `semwitness/ai-sdk` is an edge
adapter. Either can move to a separate package without changing the existing
core or IntentWitness schemas.
