# Compact Response AI SDK output

- Target release: `v0.7.0-alpha.1`
- Status: experimental, non-streaming-first
- Upstream boundary: AI SDK 7 `Output.Output`

## Outcome

`createCompactResponseOutput` asks an AI SDK 7 `LanguageModelV4` model for the
compact JSON shape selected by a parsed Compact Response contract. The adapter
supplies a draft-07-compatible response format to AI SDK; whether a provider
forwards and enforces that schema is capability-dependent. SemWitness
independently revalidates the complete raw JSON, invokes the exact local
renderer, and returns rendered bytes, a content-free witness, and a bounded
provider observation receipt through `result.output`.

This is generation-time compaction. The model emits the small intermediate
representation instead of first producing the verbose presentation text.

## Boundary

```text
host instruction + parsed Compact Response contract
  -> AI SDK JSON response format (draft-07 subset)
  -> provider generates compact JSON
  -> complete candidate only
  -> SemWitness strict revalidation and bound local rendering
  -> rendered bytes + witness + normalized final-step usage receipt
```

The bounded schema converter preserves closed objects, node-local string and
array bounds, scalar enums, and homogeneous arrays. Contract tuples use
`prefixItems`; the adapter maps them to draft-07 `items: [...]` plus
`additionalItems: false` without widening the local accepted shape. Global
`maxCandidateBytes`, `maxDepth`, aggregate `maxItems`, and aggregate
`maxStringCodeUnits` remain SemWitness local validation gates; JSON Schema does
not express those workload-wide limits.

## Public API

```ts
import { generateText } from 'ai';
import {
  createCompactResponseOutput,
  requireCompactResponseOutput,
} from 'semwitness/ai-sdk';

const result = await generateText({
  model,
  output: createCompactResponseOutput({
    contract,
    runtime,
    name: 'agent_change_report',
    description: 'Return the compact fields selected by the host.',
  }),
  prompt,
});

const { rendered, mediaType, witness, providerObservation } =
  requireCompactResponseOutput({
    read: () => result.output,
    warnings: result.warnings,
  });
```

`providerObservation` is an untrusted, content-free receipt bound to the exact
contract and witness by digests. It copies normalized final-step token counts,
the successful `stop` finish reason, and digests plus lengths for response and
model identifiers. It deliberately excludes raw identifiers, headers, bodies,
prompts, and candidates. AI SDK does not expose a provider/deployment identity
to this parser boundary, and final-step usage is not end-to-end accounting for
multi-step calls or retries. Observed usage has no paired baseline, so
`billedOutputSavings` remains `null`.

## Fail-closed behavior

Only a complete response with finish reason `stop` is eligible. AI SDK skips
custom output parsing for other `generateText` finish reasons;
`requireCompactResponseOutput` is therefore a mandatory host boundary that
maps an absent output to the same typed retry signal. It also rejects AI SDK
`responseFormat` compatibility or unsupported warnings, because those warnings
mean the provider did not receive the required schema. Malformed, oversized,
schema-invalid, timed-out, or renderer-invalid candidates throw
`CompactResponseOutputRetryRequiredError`. The error contains stable reason
codes only: it has no candidate, partial rendering, provider body, or original
exception cause. Retry and ordinary-text fallback remain explicit host policy.

The adapter never produces partial structured output. `parsePartialOutput`
returns no value and element streaming is unavailable.

## Important AI SDK caveat

AI SDK can retain the provider's raw structured candidate in `result.text`,
`result.content`, `result.finalStep`, `result.steps`, response messages,
callbacks, telemetry, and UI/text stream or pipe helpers. Compact Response
authority covers only the value returned by `requireCompactResponseOutput`.
Hosts must not publish or persist any other AI SDK result surface as a verified
rendering and should use this first adapter with `generateText`. Progressive
rendering or a transparent middleware is out of scope for this release.

## Provider capability ceiling

The adapter is AI SDK protocol-compatible, not universally provider-compatible.
For `@ai-sdk/openai-compatible`, hosts must configure
`supportsStructuredOutputs: true`; otherwise the provider adapter falls back to
`json_object`, drops the schema, and emits a warning that SemWitness rejects.
Even with that flag, strict JSON Schema subsets differ between providers and
some may reject draft-07 tuple `items: [...]` or `additionalItems`. The
credential-free transport test proves forwarding and warning behavior only; it
is not a live-provider acceptance attestation. Qualify the exact
provider/model/deployment and contract schema before production use.

## Evidence ceiling

The adapter is functional but experimental. Provider usage proves what one
compact generation consumed; it does not prove savings. A production claim
still requires at least 50 held-out counterbalanced cases, paired ordinary and
compact runs, exact refusal/retry/truncation accounting, zero task-quality
regressions, and at least 10% net output-token benefit.
