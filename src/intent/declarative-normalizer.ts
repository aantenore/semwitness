import { hashCanonical, sha256 } from '../domain/hash.js';
import { toJsonValue } from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { canonicalizeIntentIR } from './canonical.js';
import {
  canonicalIntentAliasText,
  canonicalIntentLocale,
} from './intent-lexical.js';
import { parseIntentOperationRegistry } from './normalizer-schemas.js';
import {
  type IntentCompilerRequest,
  type IntentCompilerResult,
  type IntentNormalizerManifest,
  type IntentOperationRegistry,
  type IntentOperationRegistryDocument,
  type IntentProposalCompiler,
} from './normalizer-types.js';
import type { IntentIR } from './types.js';

const NORMALIZER_ID = 'builtin-declarative-exact-alias';
const NORMALIZER_VERSION = '1.0.0';
const ARTIFACT_DIGEST = sha256(
  `semwitness.dev/builtin-declarative-exact-alias/v1\0unicode:${process.versions.unicode ?? 'unknown'}\0icu:${process.versions.icu ?? 'unknown'}`,
);

/**
 * A deterministic conformance adapter, not a general natural-language model.
 * It maps only explicitly configured locale + alias pairs to trusted registry
 * operations and abstains on everything else.
 */
export class DeclarativeIntentNormalizer
  implements IntentProposalCompiler, IntentOperationRegistry
{
  readonly manifest: IntentNormalizerManifest;
  readonly ontology: IntentOperationRegistryDocument['ontology'];
  readonly minimumConfidencePpm: number;
  readonly #aliases: ReadonlyMap<string, string>;
  readonly #operations: ReadonlyMap<string, IntentIR>;

  constructor(input: string) {
    const parsed = parseIntentOperationRegistry(input);
    const canonical = canonicalizeRegistry(parsed);
    this.ontology = Object.freeze({ ...canonical.ontology });
    this.minimumConfidencePpm = canonical.minimumConfidencePpm;
    this.manifest = Object.freeze({
      normalizer: Object.freeze({
        id: NORMALIZER_ID,
        version: NORMALIZER_VERSION,
        artifactDigest: ARTIFACT_DIGEST,
        configDigest: hashCanonical(toJsonValue(canonical)),
      }),
      ontology: this.ontology,
    });

    const aliases = new Map<string, string>();
    const operations = new Map<string, IntentIR>();
    for (const operation of canonical.operations) {
      operations.set(operation.id, operation.intent);
      for (const alias of operation.aliases) {
        aliases.set(aliasKey(alias.locale, alias.text), operation.id);
      }
    }
    this.#aliases = aliases;
    this.#operations = operations;
    Object.freeze(this);
  }

  compile(request: IntentCompilerRequest): IntentCompilerResult {
    if (
      request.signal?.aborted === true ||
      request.source.length > 16_384 ||
      request.locale.length > 64
    ) {
      return { status: 'bypass', reason: 'INTENT_COMPILER_FAILURE' };
    }
    let operationId;
    try {
      operationId = this.#aliases.get(aliasKey(request.locale, request.source));
    } catch {
      return { status: 'bypass', reason: 'INTENT_COMPILER_FAILURE' };
    }
    return operationId === undefined
      ? { status: 'bypass', reason: 'INTENT_NO_MATCH' }
      : {
          status: 'proposed',
          operationId,
          confidencePpm: 1_000_000,
          ambiguous: false,
        };
  }

  resolve(operationId: string): IntentIR | undefined {
    return this.#operations.get(operationId);
  }
}

function canonicalizeRegistry(
  input: IntentOperationRegistryDocument,
): IntentOperationRegistryDocument {
  const operations = input.operations
    .map((operation) => ({
      ...operation,
      aliases: operation.aliases
        .map((alias) => ({
          locale: canonicalIntentLocale(alias.locale),
          text: canonicalIntentAliasText(alias.text),
        }))
        .sort((left, right) =>
          compareCodeUnits(
            `${left.locale}\0${left.text}`,
            `${right.locale}\0${right.text}`,
          ),
        ),
      intent: canonicalizeIntentIR(operation.intent),
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return Object.freeze({ ...input, operations });
}

function aliasKey(locale: string, source: string): string {
  return `${canonicalIntentLocale(locale)}\0${canonicalIntentAliasText(source)}`;
}
