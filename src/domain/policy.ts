import { toJsonValue } from './canonical-json.js';
import { SemWitnessError } from './errors.js';
import { hashCanonical } from './hash.js';
import {
  EQUIVALENCE_LEVELS,
  SEGMENT_KINDS,
  SEGMENT_ROLES,
  TRUST_LEVELS,
  isEquivalenceLevel,
  isSegmentKind,
  isSegmentRole,
  isTrustLevel,
  type EquivalenceLevel,
  type Segment,
  type SegmentKind,
  type SegmentRole,
  type Sha256Digest,
  type TrustLevel,
} from './types.js';

export interface PolicyRuleMatch {
  readonly roles?: readonly SegmentRole[];
  readonly kinds?: readonly SegmentKind[];
  readonly trust?: readonly TrustLevel[];
}

export interface PolicyRule {
  readonly match: PolicyRuleMatch;
  readonly codecs: readonly string[];
  readonly allowEquivalence: readonly EquivalenceLevel[];
}

export interface CodecPolicy {
  readonly apiVersion: 'semwitness.dev/v1alpha1';
  readonly mode: 'shadow' | 'apply-verified';
  readonly rules: readonly PolicyRule[];
  readonly selection: {
    readonly objective: 'input-tokens';
    readonly minTokenSavings: number;
    readonly minSavingsRatioPpm: number;
    readonly includeDecoderLegendTokens: boolean;
    readonly allowHeuristicApply: boolean;
  };
  readonly limits: {
    readonly maxInputBytes: number;
    readonly maxEncodedBytes: number;
    readonly maxDecodeBytes: number;
    readonly maxDepth: number;
    readonly maxItems: number;
    readonly maxCodecMs: number;
  };
  readonly fallback: 'original';
  readonly tokenizerId: string;
  readonly store: {
    readonly namespace: string;
  };
}

export const DEFAULT_POLICY: CodecPolicy = Object.freeze({
  apiVersion: 'semwitness.dev/v1alpha1',
  mode: 'shadow',
  rules: Object.freeze([
    Object.freeze({
      match: Object.freeze({
        roles: Object.freeze(['system', 'developer'] as const),
      }),
      codecs: Object.freeze(['identity']),
      allowEquivalence: Object.freeze(['byte-exact'] as const),
    }),
    Object.freeze({
      match: Object.freeze({
        kinds: Object.freeze([
          'code',
          'diff',
          'tool-schema',
          'tool-call',
        ] as const),
      }),
      codecs: Object.freeze(['identity']),
      allowEquivalence: Object.freeze(['byte-exact'] as const),
    }),
    Object.freeze({
      match: Object.freeze({ kinds: Object.freeze(['log'] as const) }),
      codecs: Object.freeze(['identity', 'whitespace-rle', 'log-repeat']),
      allowEquivalence: Object.freeze([
        'byte-exact',
        'roundtrip-exact',
      ] as const),
    }),
    Object.freeze({
      match: Object.freeze({ kinds: Object.freeze(['json-data'] as const) }),
      codecs: Object.freeze(['identity', 'json-jcs']),
      allowEquivalence: Object.freeze([
        'byte-exact',
        'typed-semantic',
      ] as const),
    }),
    Object.freeze({
      match: Object.freeze({}),
      codecs: Object.freeze(['identity']),
      allowEquivalence: Object.freeze(['byte-exact'] as const),
    }),
  ]),
  selection: Object.freeze({
    objective: 'input-tokens',
    minTokenSavings: 4,
    minSavingsRatioPpm: 50_000,
    includeDecoderLegendTokens: true,
    allowHeuristicApply: false,
  }),
  limits: Object.freeze({
    maxInputBytes: 2 * 1024 * 1024,
    maxEncodedBytes: 2 * 1024 * 1024,
    maxDecodeBytes: 4 * 1024 * 1024,
    maxDepth: 64,
    maxItems: 100_000,
    maxCodecMs: 1_000,
  }),
  fallback: 'original',
  tokenizerId: 'heuristic-v1',
  store: Object.freeze({ namespace: 'default' }),
});

export function validatePolicy(value: unknown): CodecPolicy {
  if (!isRecord(value)) {
    throw policyError('Policy must be an object');
  }
  exactKeys(value, [
    'apiVersion',
    'mode',
    'rules',
    'selection',
    'limits',
    'fallback',
    'tokenizerId',
    'store',
  ]);
  if (value.apiVersion !== 'semwitness.dev/v1alpha1') {
    throw policyError('Unsupported policy apiVersion');
  }
  if (value.mode !== 'shadow' && value.mode !== 'apply-verified') {
    throw policyError('Policy mode must be shadow or apply-verified');
  }
  if (
    !Array.isArray(value.rules) ||
    value.rules.length === 0 ||
    value.rules.length > 128
  ) {
    throw policyError('Policy requires between 1 and 128 rules');
  }
  const rules = value.rules.map(parseRule);
  const selection = parseSelection(value.selection);
  const limits = parseLimits(value.limits);
  if (value.fallback !== 'original') {
    throw policyError('Only original fallback is supported');
  }
  if (
    typeof value.tokenizerId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.tokenizerId)
  ) {
    throw policyError('Invalid tokenizerId');
  }
  const store = parseStore(value.store);

  return {
    apiVersion: 'semwitness.dev/v1alpha1',
    mode: value.mode,
    rules,
    selection,
    limits,
    fallback: 'original',
    tokenizerId: value.tokenizerId,
    store,
  };
}

export function resolvePolicyRule(
  policy: CodecPolicy,
  segment: Segment,
): PolicyRule {
  const rule = policy.rules.find((candidate) =>
    ruleMatches(candidate.match, segment),
  );
  if (rule === undefined) {
    return {
      match: {},
      codecs: ['identity'],
      allowEquivalence: ['byte-exact'],
    };
  }
  return rule;
}

export function digestPolicy(policy: CodecPolicy): Sha256Digest {
  return hashCanonical(toJsonValue(policy));
}

function parseRule(value: unknown): PolicyRule {
  if (!isRecord(value)) {
    throw policyError('Policy rule must be an object');
  }
  exactKeys(value, ['match', 'codecs', 'allowEquivalence']);
  if (!isRecord(value.match)) {
    throw policyError('Policy rule match must be an object');
  }
  exactKeys(value.match, ['roles', 'kinds', 'trust']);
  const match: {
    roles?: readonly SegmentRole[];
    kinds?: readonly SegmentKind[];
    trust?: readonly TrustLevel[];
  } = {};
  if (value.match.roles !== undefined) {
    match.roles = parseEnumArray(
      value.match.roles,
      isSegmentRole,
      SEGMENT_ROLES,
      'roles',
    );
  }
  if (value.match.kinds !== undefined) {
    match.kinds = parseEnumArray(
      value.match.kinds,
      isSegmentKind,
      SEGMENT_KINDS,
      'kinds',
    );
  }
  if (value.match.trust !== undefined) {
    match.trust = parseEnumArray(
      value.match.trust,
      isTrustLevel,
      TRUST_LEVELS,
      'trust',
    );
  }
  if (
    !Array.isArray(value.codecs) ||
    value.codecs.length === 0 ||
    value.codecs.length > 32
  ) {
    throw policyError('Rule codecs must be a non-empty bounded array');
  }
  const codecs = value.codecs.map((codec) => {
    if (
      typeof codec !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(codec)
    ) {
      throw policyError('Invalid codec ID');
    }
    return codec;
  });
  const allowEquivalence = parseEnumArray(
    value.allowEquivalence,
    isEquivalenceLevel,
    EQUIVALENCE_LEVELS,
    'allowEquivalence',
  );
  return { match, codecs: [...new Set(codecs)], allowEquivalence };
}

function parseSelection(value: unknown): CodecPolicy['selection'] {
  if (!isRecord(value)) {
    throw policyError('Policy selection must be an object');
  }
  exactKeys(value, [
    'objective',
    'minTokenSavings',
    'minSavingsRatioPpm',
    'includeDecoderLegendTokens',
    'allowHeuristicApply',
  ]);
  if (value.objective !== 'input-tokens') {
    throw policyError('Only input-tokens objective is supported');
  }
  assertInteger(value.minTokenSavings, 0, 1_000_000, 'minTokenSavings');
  assertInteger(value.minSavingsRatioPpm, 0, 1_000_000, 'minSavingsRatioPpm');
  if (
    typeof value.includeDecoderLegendTokens !== 'boolean' ||
    typeof value.allowHeuristicApply !== 'boolean'
  ) {
    throw policyError('Selection flags must be booleans');
  }
  return {
    objective: 'input-tokens',
    minTokenSavings: value.minTokenSavings,
    minSavingsRatioPpm: value.minSavingsRatioPpm,
    includeDecoderLegendTokens: value.includeDecoderLegendTokens,
    allowHeuristicApply: value.allowHeuristicApply,
  };
}

function parseLimits(value: unknown): CodecPolicy['limits'] {
  if (!isRecord(value)) {
    throw policyError('Policy limits must be an object');
  }
  exactKeys(value, [
    'maxInputBytes',
    'maxEncodedBytes',
    'maxDecodeBytes',
    'maxDepth',
    'maxItems',
    'maxCodecMs',
  ]);
  assertInteger(value.maxInputBytes, 1, 64 * 1024 * 1024, 'maxInputBytes');
  assertInteger(value.maxEncodedBytes, 1, 64 * 1024 * 1024, 'maxEncodedBytes');
  assertInteger(value.maxDecodeBytes, 1, 128 * 1024 * 1024, 'maxDecodeBytes');
  assertInteger(value.maxDepth, 1, 256, 'maxDepth');
  assertInteger(value.maxItems, 1, 1_000_000, 'maxItems');
  assertInteger(value.maxCodecMs, 1, 60_000, 'maxCodecMs');
  return {
    maxInputBytes: value.maxInputBytes,
    maxEncodedBytes: value.maxEncodedBytes,
    maxDecodeBytes: value.maxDecodeBytes,
    maxDepth: value.maxDepth,
    maxItems: value.maxItems,
    maxCodecMs: value.maxCodecMs,
  };
}

function parseStore(value: unknown): CodecPolicy['store'] {
  if (!isRecord(value)) {
    throw policyError('Policy store must be an object');
  }
  exactKeys(value, ['namespace']);
  if (
    typeof value.namespace !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.namespace)
  ) {
    throw policyError('Invalid store namespace');
  }
  return { namespace: value.namespace };
}

function ruleMatches(match: PolicyRuleMatch, segment: Segment): boolean {
  return (
    (match.roles === undefined || match.roles.includes(segment.role)) &&
    (match.kinds === undefined || match.kinds.includes(segment.kind)) &&
    (match.trust === undefined || match.trust.includes(segment.trust))
  );
}

function parseEnumArray<T extends string>(
  value: unknown,
  predicate: (item: unknown) => item is T,
  _allowed: readonly T[],
  label: string,
): readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    !value.every(predicate)
  ) {
    throw policyError(`Invalid ${label} array`);
  }
  return [...new Set(value)];
}

function assertInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw policyError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw policyError(`Unknown policy fields: ${extras.sort().join(', ')}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function policyError(message: string): SemWitnessError {
  return new SemWitnessError('MALFORMED_ENVELOPE', message);
}
