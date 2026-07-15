# SemWitness threat model

_Version 0.1 design baseline — 2026-07-15_

This document defines the security and privacy invariants SemWitness v0.1 must preserve. It is not evidence that every control is implemented: source, adversarial tests, release artifacts, and CI results are authoritative. SemWitness is shadow-only by default, so a failure must preserve the original rather than promote a candidate.

## Scope and security objective

SemWitness accepts content plus caller-supplied role, kind, and trust metadata; evaluates an allowlisted codec under validated policy; stores an exact original in a local content-addressed store; and emits a proof bundle and counters. The Codex plugin invokes that workflow explicitly and does not intercept arbitrary model traffic.

The primary objective is to prevent token optimization from silently changing protected content, losing recoverability, leaking source data through evidence, or creating a net cost regression that is mislabeled as a saving.

### Assets

- Exact original bytes, including source code, instructions, tool schemas, logs, and secrets they may contain.
- Segment metadata and trust classification.
- Policy, codec, tokenizer, and schema identities and versions.
- Proof bundles, replay fixtures, promotion results, and aggregate statistics.
- Local content-addressed storage.
- The integrity of the Codex plugin bundle and CLI executable.

### Trust boundaries

1. **Caller to CLI/core:** content and metadata are untrusted until validated. A role string is not authority by itself.
2. **Policy to codec registry:** configuration may select allowlisted identifiers and bounded parameters; it must not load arbitrary code, scripts, paths, or regular expressions.
3. **Codec to verifier:** codec output and claims are adversarial inputs. The verifier recomputes evidence independently.
4. **Core to local store:** paths derive only from validated digests. Filesystem contents and metadata may have been altered by another local process.
5. **Core to report/agent:** report fields can re-enter an LLM context or terminal. Source content, control sequences, paths, and raw errors are excluded; bounded ASCII identifiers and other metadata remain untrusted data and must never be interpreted as instructions.
6. **Plugin to Codex:** plugin installation supplies a skill and bundled executable, not a transparent network or prompt hook.

### Assumptions

- The operating system, Node.js runtime, installed SemWitness release, and explicitly registered built-in adapters are trusted at process start.
- SHA-256 remains collision resistant. It provides integrity/equality evidence, not secrecy, identity, or authorship.
- A privileged host integration can supply authoritative role and trust metadata. When authority is absent or ambiguous, policy selects identity.
- The user controls and protects the local store. SemWitness cannot provide confidentiality from an administrator or a compromised user account.
- Provider token accounting and cache behavior may differ from local estimates; provider usage data is the billing authority.

## Security invariants

1. System/developer instructions, code, diffs, tool schemas, and tool calls are byte-exact by default.
2. Every reversible candidate decodes to the exact original before it can pass verification.
3. Typed JSON candidates decode to an equivalent value under strict parsing; malformed input and duplicate keys are rejected rather than normalized ambiguously.
4. The proof digest changes when protected evidence, content hashes, policy, codec, tokenizer, decision, or bundle version changes.
5. Missing, stale, malformed, oversized, unverifiable, or unsupported candidate evidence yields identity after valid boundary/tokenizer evidence exists; invalid boundary evidence fails closed before transformation.
6. V0.1 net savings include the encoded candidate and decoder-legend tokens plus configured minimum thresholds; negative benefit yields identity. Provider framing, retries, cache effects, recovery, and other host costs remain external admission evidence.
7. Proofs, stats, diagnostics, and default logs contain digests, bounded metadata, counters, and reason codes—not source content.
8. A stored original is returned only after digest, size, path-containment, and content-hash checks succeed.
9. Configuration cannot turn a data file into an executable extension point.
10. Shadow mode never substitutes the candidate for the caller-visible original.

## Threats and required controls

| Threat                                       | Abuse or failure mode                                                                                                                   | Required v0.1 control                                                                                                                                                                                       | Residual risk                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata spoofing                            | Untrusted prose is labelled as a low-risk tool result, or protected code as prose.                                                      | Validate enumerations; record metadata source; protected-default policy; require a privileged host boundary for any future active mode.                                                                     | An authorized but incorrect host can still misclassify content; replay must include misclassification cases.                                                                        |
| Instruction or marker injection              | Content forges retrieval markers, proof fields, terminal commands, or “verified” messages.                                              | Keep payload outside the evidence namespace; canonical serialization; structured JSON output; escape control characters; never execute or trust payload text.                                               | A downstream LLM may still follow malicious source text if the caller includes it. SemWitness is not a prompt-injection detector.                                                   |
| Protected-content mutation                   | A codec changes a number, negation, identifier, path, schema, instruction, or code token.                                               | Protected kinds use identity; reversible round-trip; anchor checks; independent hash comparison; identity on any mismatch.                                                                                  | Anchors are supplementary and cannot prove free-form meaning.                                                                                                                       |
| False semantic-equivalence claim             | A lossy compressor preserves fluent prose but changes intent.                                                                           | No lossy natural-language codec is admitted in v0.1; label proof scope precisely; separate mechanical verification from task evaluation.                                                                    | Future neural codecs require task-specific replay and still cannot claim universal equivalence.                                                                                     |
| Proof tampering or downgrade                 | An attacker edits hashes, reason codes, policy version, tokenizer, or schema version.                                                   | Strict versioned schema; canonical digest over all security-relevant fields; recompute evidence; reject unknown/downgraded versions.                                                                        | Unkeyed digests do not authenticate the producer. Signed or HMAC witnesses are future work.                                                                                         |
| CAS tampering                                | Stored bytes are changed after a witness is issued.                                                                                     | Re-hash on every read; bind size and digest; reject mismatch; never trust filename alone.                                                                                                                   | A local attacker can delete content and cause denial of recovery.                                                                                                                   |
| Path traversal and symlink race              | A digest or output path escapes the store, overwrites another file, or follows a hostile symlink.                                       | Accept only `sha256:<64 lowercase hex>` object IDs; resolve and verify containment; atomic create/rename; avoid following links; refuse unsafe destinations; use restrictive permissions where supported.   | Portable no-follow and permission guarantees differ on Windows; tests must cover each supported OS.                                                                                 |
| Secret leakage in evidence                   | Source snippets, prompts, credentials, URLs, headers, or raw errors enter proofs, logs, stats, or CI artifacts.                         | Allowlisted fields; reason-code errors; no snippets; redact paths and endpoints; snapshot/source-scan reports; local-only defaults.                                                                         | Digests of low-entropy values can enable offline guessing, and token/length metadata can be sensitive.                                                                              |
| Equality leakage from hashes                 | Repeated digests reveal that two inputs are equal; dictionary attacks recover small secrets.                                            | Document the property; never expose bundles unnecessarily; restrict store/report access; plan keyed or salted privacy modes.                                                                                | Plain SHA-256 cannot conceal equality or low-entropy content.                                                                                                                       |
| Parser ambiguity                             | Duplicate JSON keys, excessive depth, prototype-like keys, malformed Unicode, or numeric edge cases verify differently across runtimes. | Strict parser with byte/depth/item limits; reject duplicate keys and unsupported numeric forms; canonical value model; adversarial cross-platform fixtures.                                                 | Other ecosystems may use different JSON number or Unicode semantics; bundle version must identify the contract.                                                                     |
| Decompression bomb or resource exhaustion    | Tiny candidates expand enormously, recursive structures exhaust memory, or huge logs monopolize CPU/disk.                               | Byte/depth/item/record/operation limits; bounded file reads; preflight size checks; cooperative async codec deadline plus post-hoc elapsed-time rejection.                                                  | Synchronous JavaScript cannot be preempted in-process; custom codecs require worker/process isolation for a hard CPU deadline. V0.1 also has no automatic store quota or retention. |
| Malicious codec or configuration             | YAML imports a package, executes a command, accesses the network, or embeds catastrophic regex.                                         | Closed adapter registry at composition root; strict schemas with unknown-key rejection; no dynamic import/eval/scripts/arbitrary regex; no network capability by default.                                   | A compromised shipped adapter or dependency executes with process privileges. Supply-chain controls remain necessary.                                                               |
| Tokenizer skew and fake savings              | Local counts use the wrong model tokenizer or omit decoder/legend/retry costs.                                                          | Record tokenizer ID/fingerprint; v0.1 counts encoded content and decoder-legend tokens; configurable minimum net win; fail closed before transformation when the tokenizer is missing, malformed, or fails. | Retries, cache effects, hidden framing, and provider billing remain external costs; local savings are estimates.                                                                    |
| Prompt-cache regression                      | Rewriting a stable prefix invalidates provider cache and costs more than it saves.                                                      | V0.1 is shadow-only and makes no cache-savings claim; any active adapter must measure provider-specific cache effects externally before admission.                                                          | Host/provider cache policies may be opaque, dynamic, or model-specific.                                                                                                             |
| Replay poisoning or benchmark gaming         | A curated corpus omits failures, leaks expected answers, or overrepresents compressible logs.                                           | Strict fixtures; deterministic execution; report every bypass/failure/unassessed case; keep task-quality evaluation and corpus review external.                                                             | A passing corpus proves only those declared mechanical expectations, not task quality or future workloads.                                                                          |
| Race and partial write                       | Concurrent simulation/retrieve observes truncated content or mismatched metadata.                                                       | Content-addressed immutable objects; write temporary file, sync where appropriate, atomically rename; verify after read; tolerate duplicate writers.                                                        | Filesystem and crash semantics vary; corruption must degrade to identity/unavailable recovery, never silent success.                                                                |
| Stale or downgraded policy                   | A permissive old policy is replayed with a new codec or host.                                                                           | Bind policy digest, schema version, codec version, and tokenizer version into the witness; reject incompatible combinations; make promotion explicit.                                                       | Rollback may intentionally restore old behavior; operators must distinguish rollback from downgrade attack.                                                                         |
| Unauthorized activation                      | A plugin or wrapper silently begins sending candidates to a provider.                                                                   | Ship no live `compress` command in v0.1; plugin exposes explicit shadow commands only; active App Server/SDK integration is a separate opt-in artifact and policy.                                          | A modified third-party wrapper can ignore this contract; verify installation source and bundle digest.                                                                              |
| Misleading output-token claim                | A postprocessor claims to save output tokens after the model already generated them.                                                    | Report generation-time output separately from later storage/reuse reduction; never subtract post-generation compression from the completed provider bill.                                                   | Future-context savings remain workload- and cache-dependent.                                                                                                                        |
| Plugin or dependency supply-chain compromise | A marketplace ref, bundled CLI, install script, or dependency is replaced.                                                              | Pin release artifacts and lockfile; build in CI; audit dependencies; publish checksums/provenance where available; install reviewed tags/commits rather than mutable refs for production.                   | `--ref main` is convenient for development but mutable; production should prefer a reviewed immutable release ref.                                                                  |

## Privacy model

SemWitness deliberately stores originals because reversibility and independent verification require them. That creates a local data-retention obligation:

- Store paths are user-selected and should not be committed to a repository.
- Object and metadata files should use owner-restricted permissions where the platform supports them.
- Reports contain only bounded metadata, hashes, counts, versions, and reason codes.
- Remote telemetry, hosted storage, and automatic upload are out of scope for v0.1.
- Deletion is explicit and store-wide in v0.1; deleting an object makes future exact retrieval impossible and verification reports that fact.
- Users should not process secrets when local-disk retention is unacceptable.

Even safe reports can reveal approximate input size, content equality, timing, codec eligibility, and policy decisions. Treat bundles and replay reports as potentially sensitive operational metadata.

## Codex-specific boundary

The repository marketplace installs a skill plus a bundled CLI. It does not grant SemWitness a universal interception point inside Codex. The user or agent explicitly invokes `analyze`, `simulate`, `verify`, `retrieve`, `stats`, or `replay`; shadow mode returns the original.

An eventual Codex App Server or SDK integration would sit at a different trust boundary because it could choose content before a provider request. It must be opt-in, preserve the same witness and fallback invariants, expose whether transformed bytes were actually sent, and distinguish estimated savings from provider-observed usage.

## Required adversarial verification

Before release, automated tests should cover at least:

- byte-exact protected roles and kinds under every policy;
- property-based reversible round trips and deterministic canonical proof digests under identical adapter/runtime fingerprints plus storage and deadline outcomes;
- content, policy, codec, tokenizer, proof, and CAS tampering;
- forged roles, trust levels, retrieval markers, ANSI/control sequences, and raw-error injection;
- duplicate JSON keys, deep nesting, large numbers, malformed Unicode, and unsupported values;
- expansion ratios, oversized inputs/outputs, disk quota exhaustion, and corrupted objects;
- traversal strings, mixed path separators, symlinks, unsafe output destinations, and concurrent writers;
- tokenizer mismatch, framing overhead, negative net benefit, and prompt-cache counterexamples;
- privacy snapshots proving that source content and secrets do not enter reports or logs;
- replay corpus agreement on Linux, macOS, and Windows when no storage/deadline fault occurs, with environment fingerprints bound into evidence;
- plugin validation proving that only explicit shadow workflows are documented and bundled.

## Residual risk and release gate

No proof bundle can establish universal task correctness or future provider cost. A v0.1 release is acceptable only when protected content is byte-exact, reversible codecs round-trip, tampering is detected, diagnostics are content-free, candidate failures choose identity, invalid boundary evidence fails closed before transformation, and controlled cross-platform replay agrees. Storage availability and wall-clock deadline outcomes are intentionally recorded and may differ across runs.

The bundled replay command checks mechanical expectations, not task quality. No codec should become eligible for an active host adapter until an external held-out task evaluation, provider usage accounting, and replay evidence together show no task-quality regression and at least 10% median net token savings after all known overhead, retries, cache effects, and recovery traffic. That result remains scoped to the tested policy, tokenizer, host, model, and corpus.
