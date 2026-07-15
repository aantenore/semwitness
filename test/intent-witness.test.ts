import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  INTENT_SCHEMA,
  IntentWitnessError,
  admitCacheHit,
  canonicalIntentJson,
  createCacheEntry,
  createNormalizationWitness,
  digestIntent,
  digestIntentSource,
  hmacCacheKey,
  hmacIntentSourceDigest,
  hmacScopeDigest,
  normalizationDecision,
  parseCacheHitWitness,
  parseIntentIR,
  parseNormalizationWitness,
  verifyCacheHitWitness,
  verifyNormalizationWitness,
  verifyNormalizationWitnessIntegrity,
  type CacheBinding,
  type CacheEntry,
  type CacheLookup,
  type IntentIR,
  type NormalizationWitness,
  type ResponseDependencies,
} from '../src/intent/index.js';

const secret = '0123456789abcdef0123456789abcdef';
const ontology = {
  id: 'assistant-intents',
  version: '1.0.0',
  digest: sha256('ontology-v1'),
} as const;
const normalizerBinding = {
  id: 'typed-frame-normalizer',
  version: '1.0.0',
  artifactDigest: sha256('normalizer-artifact'),
  configDigest: sha256('normalizer-config'),
} as const;
const normalizationPolicyDigest = sha256('intent-policy');

function intent(overrides: Partial<IntentIR> = {}): IntentIR {
  return {
    schema: INTENT_SCHEMA,
    ontology,
    goal: {
      namespace: 'knowledge',
      action: 'explain',
      object: 'redis-configuration',
      polarity: 'affirm',
    },
    slots: [
      { name: 'runtime', value: 'node' },
      { name: 'version', value: 24 },
    ],
    constraints: [
      { path: 'deployment', operator: 'eq', value: 'local' },
      { path: 'unsafe', operator: 'neq', value: true },
    ],
    temporal: { kind: 'none' },
    output: { format: 'markdown', locale: 'it-IT', detail: 'concise' },
    effect: 'read',
    ...overrides,
  };
}

function normalization(
  source: string = 'Spiegami come configurare Redis',
  assessment: {
    readonly ambiguous: boolean;
    readonly confidencePpm: number;
    readonly minimumConfidencePpm: number;
  } = {
    ambiguous: false,
    confidencePpm: 980_000,
    minimumConfidencePpm: 950_000,
  },
  frame: IntentIR = intent(),
): NormalizationWitness {
  return createNormalizationWitness({
    sourceDigest: hmacIntentSourceDigest(secret, source),
    intent: frame,
    normalizer: normalizerBinding,
    ontology,
    policyDigest: normalizationPolicyDigest,
    assessment,
    candidateEvidence: [
      {
        kind: 'embedding',
        providerId: 'embedding-model',
        evidenceDigest: sha256('candidate-vector'),
        scorePpm: 999_000,
        authoritative: false,
      },
    ],
  });
}

function binding(
  witness: NormalizationWitness,
  overrides: Partial<CacheBinding> = {},
): CacheBinding {
  const tier = overrides.tier ?? 'response';
  const defaultDependencies =
    tier === 'plan'
      ? {
          operationRegistryDigest: sha256('operations-v1'),
          plannerDigest: sha256('planner-v1'),
          toolRegistryDigest: sha256('tool-registry-v1'),
        }
      : tier === 'observation'
        ? {
            planDigest: sha256('plan-v1'),
            executionDigest: sha256('execution-v1'),
            toolDigest: sha256('tools-v1'),
          }
        : {
            observationValueDigest: sha256('observation-v1'),
            outputContractDigest: sha256('output-contract-v1'),
            promptDigest: sha256('prompt-v1'),
            providerDigest: sha256('provider-v1'),
            modelDigest: sha256('model-v1'),
            determinism: 'deterministic' as const,
            determinismDigest: sha256('determinism-v1'),
            personalization: 'none' as const,
            personalizationDigest: sha256('personalization-none-v1'),
            safety: 'cache-eligible' as const,
            safetyPolicyDigest: sha256('safety-policy-v1'),
          };
  return {
    intentDigest: witness.intentDigest,
    normalization: {
      normalizer: witness.normalizer,
      policyDigest: witness.policyDigest,
      minimumConfidencePpm: witness.assessment.minimumConfidencePpm,
    },
    scope: {
      cacheNamespace: hmacScopeDigest(
        'cache-namespace',
        secret,
        'assistant-cache',
      ),
      tenant: hmacScopeDigest('tenant', secret, 'tenant-a'),
      principal: hmacScopeDigest('principal', secret, 'user-a'),
    },
    authorizationDigest: hmacScopeDigest(
      'authorization',
      secret,
      'roles:reader',
    ),
    contextDigest: hmacScopeDigest('context', secret, 'workspace-a'),
    policyDigest: sha256('cache-policy-v1'),
    effect: 'read',
    tier,
    dependencies: defaultDependencies,
    ...overrides,
  } as CacheBinding;
}

function ttlPair(
  witness: NormalizationWitness = normalization(),
  bindingOverrides: Partial<CacheBinding> = {},
): { readonly entry: CacheEntry; readonly lookup: CacheLookup } {
  const cacheBinding = binding(witness, bindingOverrides);
  return {
    entry: createCacheEntry({
      valueDigest: sha256('cached-value'),
      binding: cacheBinding,
      freshness: { kind: 'ttl', createdAtEpochMs: 1_000, ttlMs: 1_000 },
    }),
    lookup: {
      binding: cacheBinding,
      freshness: { kind: 'ttl', checkedAtEpochMs: 1_500 },
    },
  };
}

function withResponseDependencies(
  current: CacheBinding,
  overrides: Partial<ResponseDependencies>,
): CacheBinding {
  if (current.tier !== 'response')
    throw new TypeError('Expected response tier');
  return {
    ...current,
    dependencies: { ...current.dependencies, ...overrides },
  };
}

function admit(
  entry: CacheEntry,
  lookup: CacheLookup,
  normal: NormalizationWitness,
  frame: IntentIR = intent(),
) {
  return admitCacheHit({
    entry,
    lookup,
    normalizationWitness: normal,
    sourceDigest: normal.sourceDigest,
    intent: frame,
    expectedNormalizer: normal.normalizer,
    expectedNormalizationPolicyDigest: normal.policyDigest,
    expectedMinimumConfidencePpm: normal.assessment.minimumConfidencePpm,
  });
}

function verifyHit(
  witness: ReturnType<typeof admitCacheHit>,
  normal: NormalizationWitness,
  frame: IntentIR = intent(),
) {
  return verifyCacheHitWitness(witness, {
    normalizationWitness: normal,
    sourceDigest: normal.sourceDigest,
    intent: frame,
    expectedNormalizer: normal.normalizer,
    expectedNormalizationPolicyDigest: normal.policyDigest,
    expectedMinimumConfidencePpm: normal.assessment.minimumConfidencePpm,
  });
}

describe('IntentIR canonicalization', () => {
  it('gives paraphrases the same intent key while binding different sources', () => {
    const first = normalization('Spiegami come configurare Redis');
    const second = normalization('Come si configura Redis?');

    expect(first.sourceDigest).not.toBe(second.sourceDigest);
    expect(first.intentDigest).toBe(second.intentDigest);
    expect(first.claim).toEqual({
      kind: 'bounded-typed-intent-normalization',
      universalNaturalLanguageEquivalence: false,
      cacheAuthorization: 'none',
    });
    expect(first.decision).toEqual({
      verdict: 'eligible',
      applied: false,
      reasons: ['INTENT_NORMALIZATION_ELIGIBLE'],
    });
    expect(first.candidateEvidence[0]).toMatchObject({
      kind: 'embedding',
      authoritative: false,
    });
    expect(JSON.stringify(first)).not.toContain('Spiegami');
  });

  it('is deterministic across object, slot, constraint and duplicate order', () => {
    const reordered = intent({
      slots: [
        { value: 24, name: 'version' },
        { value: 'node', name: 'runtime' },
      ],
      constraints: [
        { value: true, operator: 'neq', path: 'unsafe' },
        { value: 'local', operator: 'eq', path: 'deployment' },
        { value: 'local', operator: 'eq', path: 'deployment' },
      ],
    });

    expect(digestIntent(reordered)).toBe(digestIntent(intent()));
    expect(canonicalIntentJson(reordered)).toBe(canonicalIntentJson(intent()));
    expect(parseIntentIR(reordered).constraints).toHaveLength(2);
  });

  it('separates negation, changed slots and temporal qualifiers', () => {
    const base = digestIntent(intent());
    const negated = digestIntent(
      intent({ goal: { ...intent().goal, polarity: 'negate' } }),
    );
    const changedSlot = digestIntent(
      intent({
        slots: [
          { name: 'runtime', value: 'node' },
          { name: 'version', value: 22 },
        ],
      }),
    );
    const timed = digestIntent(
      intent({
        temporal: { kind: 'as-of', instant: '2026-07-15T10:00:00.000Z' },
      }),
    );

    expect(new Set([base, negated, changedSlot, timed])).toHaveLength(4);
  });

  it('rejects unknown fields, duplicate JSON keys and oversized documents', () => {
    expect(() => parseIntentIR({ ...intent(), unexpected: true })).toThrow(
      IntentWitnessError,
    );
    expect(() =>
      parseIntentIR(
        canonicalIntentJson(intent()).replace(
          '"effect":"read"',
          '"effect":"read","effect":"write"',
        ),
      ),
    ).toThrow(IntentWitnessError);
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [{ name: 'payload', value: 'x'.repeat(70_000) }],
      }),
    ).toThrow(IntentWitnessError);
  });

  it('domain-separates scope HMACs and rejects weak keys', () => {
    expect(hmacScopeDigest('tenant', secret, 'same')).not.toBe(
      hmacScopeDigest('principal', secret, 'same'),
    );
    expect(() => hmacScopeDigest('tenant', 'weak', 'tenant-a')).toThrow(
      /32 bytes/u,
    );
    expect(() => hmacScopeDigest('tenant', secret, 'tenant-\ud800')).toThrow(
      /well-formed Unicode/u,
    );
    expect(() => digestIntentSource('request-\ud800')).toThrow(
      /well-formed Unicode/u,
    );
    expect(() => hmacIntentSourceDigest(secret, 'request-\ud800')).toThrow(
      /well-formed Unicode/u,
    );
  });

  it('builds a deterministic cache key from the complete validated binding', () => {
    const normal = normalization();
    const current = binding(normal);
    const first = hmacCacheKey(secret, current);

    expect(first).toBe(hmacCacheKey(secret, structuredClone(current)));
    expect(first).not.toBe(
      hmacCacheKey(secret, binding(normal, { tier: 'observation' })),
    );
    expect(first).not.toBe(
      hmacCacheKey(secret, {
        ...current,
        scope: {
          ...current.scope,
          tenant: hmacScopeDigest('tenant', secret, 'tenant-b'),
        },
      }),
    );
    expect(() => hmacCacheKey('weak', current)).toThrow(/32 bytes/u);
    expect(() =>
      hmacCacheKey(secret, {
        ...current,
        dependencies: {
          observationValueDigest: sha256('observation-v1'),
        },
      } as CacheBinding),
    ).toThrow(IntentWitnessError);
    expect(() =>
      hmacCacheKey(secret, {
        ...current,
        dependencies: {
          ...current.dependencies,
          determinism: 'unknown',
        },
      } as unknown as CacheBinding),
    ).toThrow(IntentWitnessError);
  });

  it('rejects malformed Unicode and preflights large or deep object inputs', () => {
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [{ name: 'runtime', value: '\ud800' }],
      }),
    ).toThrow(IntentWitnessError);
    expect(() =>
      parseIntentIR(JSON.stringify(intent()).replace('"node"', '"\\ud800"')),
    ).toThrow(IntentWitnessError);
    const prototypeKey = JSON.parse('{"__proto__":{"role":"admin"}}');
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [{ name: 'runtime', value: prototypeKey }],
      }),
    ).toThrow(IntentWitnessError);
    expect(() =>
      parseIntentIR(
        JSON.stringify(intent()).replace(
          '"node"',
          '{"__proto__":{"role":"admin"}}',
        ),
      ),
    ).toThrow(IntentWitnessError);
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: Array.from({ length: 10_000 }, () => ({
          name: 'runtime',
          value: 'node',
        })),
      }),
    ).toThrow(IntentWitnessError);

    let nested: unknown = 'leaf';
    for (let index = 0; index < 100; index += 1) nested = { nested };
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [{ name: 'runtime', value: nested }],
      }),
    ).toThrow(IntentWitnessError);

    const shared = { nested: 'value' };
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [
          { name: 'first', value: shared },
          { name: 'second', value: shared },
        ],
      }),
    ).not.toThrow();

    const arrayWithNonIndexProperty = ['node'];
    Object.defineProperty(arrayWithNonIndexProperty, '4294967295', {
      value: 'hidden',
      enumerable: true,
    });
    expect(() =>
      parseIntentIR({
        ...intent(),
        slots: [{ name: 'runtime', value: arrayWithNonIndexProperty }],
      }),
    ).toThrow(IntentWitnessError);
  });
});

describe('normalization witness admission', () => {
  it('fails closed on ambiguity and low confidence', () => {
    const ambiguous = normalization('do it', {
      ambiguous: true,
      confidencePpm: 980_000,
      minimumConfidencePpm: 950_000,
    });
    const lowConfidence = normalization('maybe do it', {
      ambiguous: false,
      confidencePpm: 700_000,
      minimumConfidencePpm: 950_000,
    });

    expect(ambiguous.decision).toMatchObject({
      verdict: 'bypass',
      applied: false,
      reasons: ['INTENT_AMBIGUOUS'],
    });
    expect(lowConfidence.decision).toMatchObject({
      verdict: 'bypass',
      reasons: ['INTENT_CONFIDENCE_LOW'],
    });
    expect(
      normalizationDecision({
        ambiguous: false,
        confidencePpm: Number.NaN,
        minimumConfidencePpm: 0,
      }),
    ).toEqual({
      verdict: 'bypass',
      applied: false,
      reasons: ['INTENT_MALFORMED'],
    });
    expect(
      normalizationDecision(
        null as unknown as Parameters<typeof normalizationDecision>[0],
      ),
    ).toMatchObject({
      verdict: 'bypass',
      reasons: ['INTENT_MALFORMED'],
    });
  });

  it('detects tampering and rejects authoritative similarity evidence', () => {
    const witness = normalization();
    const tampered = {
      ...witness,
      assessment: { ...witness.assessment, confidencePpm: 1 },
    };

    expect(verifyNormalizationWitnessIntegrity(tampered)).toEqual({
      verified: false,
      reasons: ['INTENT_WITNESS_TAMPERED'],
    });
    expect(() =>
      parseNormalizationWitness({
        ...witness,
        candidateEvidence: witness.candidateEvidence.map((candidate) => ({
          ...candidate,
          authoritative: true,
        })),
      }),
    ).toThrow(IntentWitnessError);
    expect(() =>
      parseNormalizationWitness({ ...witness, rawUtterance: 'secret' }),
    ).toThrow(IntentWitnessError);
    expect(
      verifyNormalizationWitness(witness, {
        sourceDigest: witness.sourceDigest,
        intent: { ...intent(), unexpected: true } as IntentIR,
        normalizer: witness.normalizer,
        policyDigest: witness.policyDigest,
        minimumConfidencePpm: witness.assessment.minimumConfidencePpm,
      }),
    ).toEqual({ verified: false, reasons: ['INTENT_MALFORMED'] });
    expect(verifyNormalizationWitnessIntegrity(witness)).toEqual({
      verified: true,
      reasons: [],
    });
    expect(
      (verifyNormalizationWitness as unknown as (input: unknown) => unknown)(
        witness,
      ),
    ).toEqual({ verified: false, reasons: ['INTENT_MALFORMED'] });
    expect(
      verifyNormalizationWitness(witness, {
        sourceDigest: witness.sourceDigest,
        intent: intent(),
        normalizer: {
          ...witness.normalizer,
          artifactDigest: sha256('normalizer-upgrade'),
        },
        policyDigest: sha256('normalization-policy-upgrade'),
        minimumConfidencePpm: 990_000,
      }),
    ).toEqual({
      verified: false,
      reasons: ['INTENT_NORMALIZER_MISMATCH', 'INTENT_POLICY_MISMATCH'],
    });
    expect(
      verifyNormalizationWitness(witness, {
        sourceDigest: witness.sourceDigest,
        intent: intent(),
        normalizer: null,
        policyDigest: witness.policyDigest,
        minimumConfidencePpm: witness.assessment.minimumConfidencePpm,
      } as unknown as Parameters<typeof verifyNormalizationWitness>[1]),
    ).toEqual({ verified: false, reasons: ['INTENT_MALFORMED'] });
  });

  it('validates bounded factory inputs before sorting or hashing them', () => {
    const base = normalization();
    expect(() =>
      createNormalizationWitness({
        sourceDigest: base.sourceDigest,
        intent: intent(),
        normalizer: base.normalizer,
        ontology,
        policyDigest: base.policyDigest,
        assessment: base.assessment,
        candidateEvidence: Array.from({ length: 10_000 }, () => ({
          kind: 'embedding' as const,
          providerId: 'candidate',
          evidenceDigest: sha256('candidate'),
          scorePpm: 1,
          authoritative: false as const,
        })),
      }),
    ).toThrow(IntentWitnessError);

    const current = binding(base);
    expect(() =>
      createCacheEntry({
        valueDigest: sha256('value'),
        binding: current,
        freshness: {
          kind: 'revision-set',
          revisions: Array.from({ length: 10_000 }, () => ({
            namespace: 'source',
            digest: sha256('revision'),
          })),
        },
      }),
    ).toThrow(IntentWitnessError);
  });
});

describe('cache-hit shadow admission', () => {
  it('marks an exact, fresh, read-only response candidate eligible but never applies it', () => {
    const normal = normalization();
    const { entry, lookup } = ttlPair(normal);
    const witness = admit(entry, lookup, normal);

    expect(witness.decision).toEqual({
      verdict: 'eligible',
      applied: false,
      reasons: ['CACHE_HIT_ELIGIBLE'],
    });
    expect(witness.claim).toEqual({
      comparison: 'exact-bound-digests',
      candidateEvidenceAuthorizesHit: false,
      universalSemanticEquivalence: false,
    });
    expect(verifyHit(witness, normal)).toEqual({
      verified: true,
      reasons: [],
    });
    expect(verifyCacheHitWitness(witness)).toEqual({
      verified: false,
      reasons: ['CACHE_NORMALIZATION_WITNESS_INVALID'],
    });
  });

  it.each([
    [
      'CACHE_TENANT_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        scope: {
          ...current.scope,
          tenant: hmacScopeDigest('tenant', secret, 'tenant-b'),
        },
      }),
    ],
    [
      'CACHE_AUTHORIZATION_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        authorizationDigest: hmacScopeDigest(
          'authorization',
          secret,
          'roles:admin',
        ),
      }),
    ],
    [
      'CACHE_CONTEXT_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        contextDigest: hmacScopeDigest('context', secret, 'workspace-b'),
      }),
    ],
    [
      'CACHE_PROMPT_MISMATCH',
      (current: CacheBinding): CacheBinding =>
        withResponseDependencies(current, {
          promptDigest: sha256('prompt-v2'),
        }),
    ],
    [
      'CACHE_MODEL_MISMATCH',
      (current: CacheBinding): CacheBinding =>
        withResponseDependencies(current, { modelDigest: sha256('model-v2') }),
    ],
    [
      'CACHE_NORMALIZER_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        normalization: {
          ...current.normalization,
          normalizer: {
            ...current.normalization.normalizer,
            artifactDigest: sha256('normalizer-v2'),
          },
        },
      }),
    ],
    [
      'CACHE_NORMALIZATION_POLICY_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        normalization: {
          ...current.normalization,
          policyDigest: sha256('normalization-policy-v2'),
        },
      }),
    ],
    [
      'CACHE_NORMALIZATION_POLICY_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        normalization: {
          ...current.normalization,
          minimumConfidencePpm: 990_000,
        },
      }),
    ],
    [
      'CACHE_POLICY_MISMATCH',
      (current: CacheBinding): CacheBinding => ({
        ...current,
        policyDigest: sha256('cache-policy-v2'),
      }),
    ],
  ] as const)('bypasses on %s', (reason, mutate) => {
    const normal = normalization();
    const pair = ttlPair(normal);
    const witness = admit(
      pair.entry,
      { ...pair.lookup, binding: mutate(pair.lookup.binding) },
      normal,
    );

    expect(witness.decision).toMatchObject({
      verdict: 'bypass',
      applied: false,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it('requires and compares the dependency vector for every cache tier', () => {
    const normal = normalization();
    const plan = ttlPair(normal, { tier: 'plan' });
    if (plan.lookup.binding.tier !== 'plan')
      throw new TypeError('plan fixture');
    const changedPlan = admit(
      plan.entry,
      {
        ...plan.lookup,
        binding: {
          ...plan.lookup.binding,
          dependencies: {
            ...plan.lookup.binding.dependencies,
            plannerDigest: sha256('planner-v2'),
          },
        },
      },
      normal,
    );
    expect(changedPlan.decision.reasons).toContain('CACHE_PLANNER_MISMATCH');

    const observation = ttlPair(normal, { tier: 'observation' });
    if (observation.lookup.binding.tier !== 'observation') {
      throw new TypeError('observation fixture');
    }
    const changedObservation = admit(
      observation.entry,
      {
        ...observation.lookup,
        binding: {
          ...observation.lookup.binding,
          dependencies: {
            ...observation.lookup.binding.dependencies,
            toolDigest: sha256('tool-v2'),
          },
        },
      },
      normal,
    );
    expect(changedObservation.decision.reasons).toContain(
      'CACHE_TOOL_MISMATCH',
    );

    const response = ttlPair(normal);
    if (response.lookup.binding.tier !== 'response') {
      throw new TypeError('response fixture');
    }
    const changedResponse = admit(
      response.entry,
      {
        ...response.lookup,
        binding: withResponseDependencies(response.lookup.binding, {
          safetyPolicyDigest: sha256('safety-v2'),
        }),
      },
      normal,
    );
    expect(changedResponse.decision.reasons).toContain(
      'CACHE_SAFETY_POLICY_MISMATCH',
    );
  });

  it('rejects a stale TTL and a changed revision set', () => {
    const normal = normalization();
    const stale = ttlPair(normal);
    const staleWitness = admit(
      stale.entry,
      {
        ...stale.lookup,
        freshness: { kind: 'ttl', checkedAtEpochMs: 2_000 },
      },
      normal,
    );
    expect(staleWitness.decision.reasons).toContain('CACHE_STALE');

    const cacheBinding = binding(normal);
    const revisionEntry = createCacheEntry({
      valueDigest: sha256('value'),
      binding: cacheBinding,
      freshness: {
        kind: 'revision-set',
        revisions: [
          { namespace: 'documents', digest: sha256('docs-v1') },
          { namespace: 'tools', digest: sha256('tools-v1') },
        ],
      },
    });
    const changed = admit(
      revisionEntry,
      {
        binding: cacheBinding,
        freshness: {
          kind: 'revision-set',
          revisions: [
            { namespace: 'tools', digest: sha256('tools-v1') },
            { namespace: 'documents', digest: sha256('docs-v2') },
          ],
        },
      },
      normal,
    );
    expect(changed.decision.reasons).toContain('CACHE_REVISION_MISMATCH');

    const reordered = admit(
      revisionEntry,
      {
        binding: cacheBinding,
        freshness: {
          kind: 'revision-set',
          revisions: [
            ...(revisionEntry.freshness.kind === 'revision-set'
              ? revisionEntry.freshness.revisions
              : []),
          ].reverse(),
        },
      },
      normal,
    );
    expect(reordered.decision.verdict).toBe('eligible');
  });

  it('allows write and irreversible reuse only at the plan tier', () => {
    const writeFrame = intent({ effect: 'write' });
    const writeNormal = normalization(
      'Aggiorna la configurazione',
      undefined,
      writeFrame,
    );
    const response = ttlPair(writeNormal, {
      effect: 'write',
      tier: 'response',
    });
    expect(
      admit(response.entry, response.lookup, writeNormal, writeFrame).decision
        .reasons,
    ).toContain('CACHE_TIER_EFFECT_FORBIDDEN');

    const irreversibleFrame = intent({ effect: 'irreversible' });
    const irreversibleNormal = normalization(
      'Elimina definitivamente il dato',
      undefined,
      irreversibleFrame,
    );
    const observation = ttlPair(irreversibleNormal, {
      effect: 'irreversible',
      tier: 'observation',
    });
    expect(
      admit(
        observation.entry,
        observation.lookup,
        irreversibleNormal,
        irreversibleFrame,
      ).decision.reasons,
    ).toContain('CACHE_TIER_EFFECT_FORBIDDEN');

    const plan = ttlPair(writeNormal, { effect: 'write', tier: 'plan' });
    expect(
      admit(plan.entry, plan.lookup, writeNormal, writeFrame).decision.verdict,
    ).toBe('eligible');

    const mislabeledRead = ttlPair(writeNormal);
    expect(
      admit(
        mislabeledRead.entry,
        mislabeledRead.lookup,
        writeNormal,
        writeFrame,
      ).decision.reasons,
    ).toContain('CACHE_EFFECT_MISMATCH');
  });

  it('detects entry and witness tampering and rejects unknown witness fields', () => {
    const normal = normalization();
    const pair = ttlPair(normal);
    const badEntry = {
      ...pair.entry,
      valueDigest: sha256('substituted-value'),
    };
    expect(admit(badEntry, pair.lookup, normal).decision.reasons).toContain(
      'CACHE_ENTRY_DIGEST_MISMATCH',
    );

    const witness = admit(pair.entry, pair.lookup, normal);
    const tampered = {
      ...witness,
      lookup: {
        ...witness.lookup,
        binding: {
          ...witness.lookup.binding,
          dependencies: {
            ...witness.lookup.binding.dependencies,
            promptDigest: sha256('tampered-prompt'),
          },
        },
      },
    };
    expect(
      verifyCacheHitWitness(tampered, {
        normalizationWitness: normal,
        sourceDigest: normal.sourceDigest,
        intent: intent(),
        expectedNormalizer: normal.normalizer,
        expectedNormalizationPolicyDigest: normal.policyDigest,
        expectedMinimumConfidencePpm: normal.assessment.minimumConfidencePpm,
      }),
    ).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['CACHE_WITNESS_TAMPERED']),
    });
    expect(() =>
      parseCacheHitWitness({ ...witness, response: 'secret' }),
    ).toThrow(IntentWitnessError);
    expect(
      verifyCacheHitWitness(witness, {
        normalizationWitness: normal,
        sourceDigest: normal.sourceDigest,
        intent: { ...intent(), unexpected: true } as IntentIR,
        expectedNormalizer: normal.normalizer,
        expectedNormalizationPolicyDigest: normal.policyDigest,
        expectedMinimumConfidencePpm: normal.assessment.minimumConfidencePpm,
      }),
    ).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining([
        'INTENT_MALFORMED',
        'CACHE_NORMALIZATION_WITNESS_INVALID',
      ]),
    });
  });
});
