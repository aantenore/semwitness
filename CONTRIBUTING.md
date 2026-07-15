# Contributing

SemWitness treats compression as a safety-sensitive transformation. A change is useful only when its claims are reproducible and its failure mode preserves the original.

## Development

Requirements: Node.js 24+ and Corepack.

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

Before proposing a codec or tokenizer adapter:

- register it explicitly at the composition root; configuration must never load executable code;
- define its equivalence claim precisely and version its wire grammar;
- include decoder/framing cost in token evidence;
- add round-trip, malformed-input, expansion-limit, determinism, and privacy tests;
- keep system/developer/code/diff/tool-schema/tool-call paths byte-exact;
- demonstrate fail-closed identity fallback;
- add replay evidence without committing private prompts or secrets.

Do not include generated output, credentials, real private transcripts, `.semwitness/` stores, or source snippets in diagnostic fixtures. Use synthetic data.

## Pull requests

Keep changes modular and configuration-driven. Explain the invariant being added or changed, the proof field or reason code that exposes it, negative tests, net-token impact, cache assumptions, and residual risk. Breaking proof/codec grammar changes require a new version rather than reinterpretation of an existing identifier.

Security issues belong in private vulnerability reports, not public issues.
