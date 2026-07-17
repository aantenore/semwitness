# Compact Response architecture

## Boundary

```text
host-selected output contract
  -> model generates compact strict JSON
  -> bounded schema validation
  -> exact renderer binding
  -> deterministic local rendering
  -> content-free witness
  -> optional exact replay verification
```

The model does not repeat the contract, schema, renderer metadata, or digests.
Those values travel out of band and are bound by the witness. This avoids
turning protocol metadata into output-token overhead.

`semwitness/response` owns five things:

1. the compact-response contract and bounded schema dialect;
2. strict candidate parsing and validation;
3. a host-controlled renderer registry;
4. deterministic content-free witnesses;
5. replay verification against the same bound renderer.

It does not own provider calls, prompt construction, retries, routing, intent
normalization, or cache admission. IntentWitness already carries an
`outputContractDigest` for response dependencies. IntentABI can associate a
normalized operation with that digest without moving either authority.

## Schema dialect

`semwitness.dev/bounded-json-schema/v1alpha1` is intentionally not full JSON
Schema. Each node requires one type and accepts only:

- `null`, `boolean`, `number`, and `integer`, with optional `enum`, `minimum`,
  and `maximum` where meaningful;
- `string`, with optional `enum`, `minLength`, and `maxLength`;
- `array`, with either one homogeneous `items` schema or `prefixItems` plus
  `items: false`, and optional `minItems`/`maxItems`;
- `object`, with `properties`, unique `required`, and mandatory
  `additionalProperties: false`.

References, composition, pattern matching, coercion, defaults, annotations,
and executable extensions are unsupported. The implementation applies both
contract-wide parser limits and node-local schema limits.

## Renderer binding

A renderer registration contains immutable `id`, `version`, `artifactDigest`,
`outputMediaType`, supported locales, and a captured render function. The
contract must match all of them exactly. The artifact digest identifies the
reviewed implementation profile; it is integrity metadata, not producer
authentication.

The renderer receives a deep-frozen JSON value, selected locale, and an abort
signal. Output is copied before validation. Async timeout can revoke authority
to return a result, although JavaScript cannot pre-empt synchronous CPU work;
untrusted renderer code therefore belongs in an isolated worker or process.

## Witness

The witness contains only:

- canonical contract digest;
- exact candidate-byte digest and length;
- renderer identity, version, artifact digest, media type, and locale;
- exact rendered-byte digest and length;
- optional tokenizer identity, fingerprint, reliability, and local projection;
- `billedOutputSavings: null`;
- decision and witness digest.

The candidate and rendered content never appear. A verifier reruns the bound
renderer and compares the complete canonical witness, not just one digest.

## First profile

The `change-report-markdown@1` profile expands compact status, summary, change,
verification, and warning fields into deterministic English Markdown. All
model-provided Markdown metacharacters are escaped and file paths use safe code
spans. This profile is a demonstration contract, not a privileged core format.
