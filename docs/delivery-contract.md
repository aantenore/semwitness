# Delivery contract: SemWitness

- Date: 2026-07-15
- Mode: new project
- Status: active

## Objective

Deliver a provider-neutral shadow codec and Compression CI that can prove exactly what changed, measure net token impact, and fail closed to the original content. Package the workflow as a self-contained Codex plugin without claiming prompt interception.

## Scope

Must:

- Keep system, developer, code, diff, tool-schema, and tool-call segments byte-exact by default.
- Use explicit role, kind, and trust metadata supplied by the host.
- Persist originals in a content-addressed local store and verify hashes on read.
- Emit deterministic proof envelopes with policy, codec, anchor, token, and decision evidence.
- Count decoder/legend overhead and reject candidates below the configured net-win threshold.
- Default to shadow mode and return the untouched original on every verification or adapter failure.
- Provide a CLI, replay fixtures, tests, and a validated Codex plugin bundle.

Should:

- Support identity, reversible whitespace RLE, repeated-log-line, and canonical JSON codecs.
- Keep all adapters replaceable through an allowlisted registry and validated configuration.
- Run on Node 24 across Linux, macOS, and Windows.

Out of scope for v0.1:

- Transparent mutation of Codex prompts or responses.
- Claims of universal semantic equivalence for natural language.
- Neural codecs, remote telemetry, hosted storage, automatic model routing, or npm publication.
- Claude integration; the core ports must nevertheless remain host-neutral.

## Acceptance criteria

| ID  | Requirement        | Acceptance                                                                                                           | Verification                              |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R1  | Protected paths    | Protected roles/kinds are byte-identical in every mode                                                               | Unit and property tests                   |
| R2  | Canonical evidence | Same input, policy, adapter/runtime fingerprints, storage state, and deadline outcome produce the same proof digest  | Repeated and controlled cross-platform CI |
| R3  | Round trip         | Reversible codecs decode byte-for-byte                                                                               | Property tests                            |
| R4  | Typed JSON         | Canonical JSON decodes to an identical value                                                                         | Fixture and negative tests                |
| R5  | Proof integrity    | Encoded, original, policy, and proof tampering is detected                                                           | Adversarial tests                         |
| R6  | Safe fallback      | Candidate/verifier/CAS faults yield identity; invalid boundary/tokenizer evidence fails closed before transformation | Fault injection tests                     |
| R7  | Privacy            | Reports and stats contain digests/counters, not source content                                                       | Snapshot and source scan                  |
| R8  | Honest integration | Plugin documents explicit shadow commands only                                                                       | Manifest/skill validation                 |
| R9  | Net benefit        | Candidates include overhead and configurable threshold                                                               | Replay report                             |
| R10 | Delivery           | Format, lint, typecheck, test, build, audit, pack and plugin validation pass                                         | Local and GitHub CI                       |

## Architecture

A modular monolith separates domain contracts, application orchestration, ports, allowlisted adapters, CLI entrypoints, replay evaluation, and host integrations. YAML selects registered IDs only; it cannot import packages, scripts, or arbitrary regexes. The Codex plugin contains a bundled runtime because installation snapshots only the plugin directory.

## Security and privacy

The threat model includes role spoofing, marker injection, decompression bombs, duplicate JSON keys, tokenizer skew, prompt-cache regression, proof/CAS tampering, path traversal, symlink races, and content leakage through logs. Inputs and decoded outputs have byte, depth, item, and codec-specific operation limits. Local CAS paths derive only from validated SHA-256 digests and use restrictive permissions where supported.

## Delivery policy

- Delivery: public GitHub repository on `aantenore`, commit and push `main` after all gates pass.
- Identity: `Antonio Antenore <50747458+aantenore@users.noreply.github.com>` only.
- CI: Node 24 on Ubuntu, macOS, and Windows plus dependency audit. CodeQL uses GitHub default setup enabled as a repository setting after the initial push, not an uncommitted workflow claim.
- Rollback: revert the release commit; shadow mode and identity fallback remain the runtime safety net.

## Residual gate

The bundled replay runner proves only deterministic mechanical expectations. No codec is eligible for live rewriting until an external held-out task evaluation, provider usage accounting, and the replay report together show no task-quality regression and at least 10% median net token savings, including retries, legends, cache effects, extra context, and recovery.
