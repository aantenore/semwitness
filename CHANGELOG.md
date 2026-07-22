# Changelog

All notable changes to SemWitness are documented here. The project follows
[Semantic Versioning](https://semver.org/) while alpha releases may still evolve
their public contracts.

## [Unreleased]

## [0.8.0-alpha.1] - 2026-07-22

### Added

- Resumable, content-free checkpoints for intent-normalizer evaluation. A
  claimed attempt without a committed result is indeterminate and never retried
  implicitly.
- An optional, strictly allowlisted OpenAI-compatible `reasoningEffort` policy.
  Its exact value is forwarded as `reasoning_effort` and bound into the compiler
  configuration digest.

### Changed

- The public overview now starts with plain-language impact and examples.
- OpenAI-compatible intent compiler lineage advances to `0.2.0`; omitting
  `reasoningEffort` preserves the endpoint default, while unsupported values,
  endpoint rejection, or returned reasoning fail closed.

### Fixed

- Runtime-bound evaluator fixtures are normalized consistently.
- The Compact Response deadline test no longer depends on a one-millisecond
  scheduling window.

### Safety boundary

- Intent evaluation remains shadow-only and cannot authorize cache serving.
- Compact Response and promotion evidence retain their existing fail-closed
  activation ceilings.

[Unreleased]: https://github.com/aantenore/semwitness/compare/v0.8.0-alpha.1...HEAD
[0.8.0-alpha.1]: https://github.com/aantenore/semwitness/compare/v0.7.0-alpha.1...v0.8.0-alpha.1
