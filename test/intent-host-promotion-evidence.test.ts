import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
  INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
  INTENT_CACHE_OPERATION_BINDING_SCHEMA,
  INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
  INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
  MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES,
  digestIntentCachePromotionAdversarialCorpus,
  digestIntentCachePromotionPopulationCorpus,
  digestIntentCachePromotionUsageFailures,
  parseIntentCacheEntrySourceBinding,
  parseIntentCacheLookupReceipt,
  parseIntentCacheOperationBinding,
  parseIntentCachePromotionEvidenceFixture,
  parseIntentCachePromotionEvidenceJsonl,
  parseIntentNormalizationBypassReceipt,
  recomputeIntentCacheEntrySourceBindingDigest,
  recomputeIntentCacheLookupReceiptDigest,
  recomputeIntentCacheOperationBindingDigest,
  recomputeIntentCachePromotionEvidenceBindingDigest,
  recomputeIntentCachePromotionEvidenceCaseDigest,
  recomputeIntentNormalizationBypassReceiptDigest,
  type IntentCacheAccountingBinding,
  type IntentCacheDependencyBinding,
  type IntentCacheDependencyInventory,
  type IntentCacheDomainHmac,
  type IntentCacheEntrySourceBinding,
  type IntentCacheLookupReceipt,
  type IntentCacheOperationBinding,
  type IntentCacheOperationHmac,
  type IntentCachePromotionEvidenceCase,
  type IntentCachePromotionEvidenceFixture,
  type IntentCachePromotionUsagePair,
  type IntentNormalizationBypassReceipt,
} from '../src/intent-host/index.js';
import {
  INTENT_SCHEMA,
  admitCacheHit,
  createCacheEntry,
  createNormalizationWitness,
  hmacIntentSourceDigest,
  hmacScopeDigest,
  type CacheBinding,
  type CacheKeyDigest,
  type IntentEffect,
  type IntentIR,
  type NormalizationWitness,
  type NormalizerBinding,
  type OntologyBinding,
} from '../src/intent/index.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const SECRET = '0123456789abcdef0123456789abcdef';
const OPERATION =
  `hmac-sha256:operation:${'1'.repeat(64)}` as IntentCacheOperationHmac;
const PROBE_OPERATION =
  `hmac-sha256:operation:${'2'.repeat(64)}` as IntentCacheOperationHmac;
const DOMAIN =
  `hmac-sha256:intent-domain:${'3'.repeat(64)}` as IntentCacheDomainHmac;
const CACHE_NAMESPACE = hmacScopeDigest(
  'cache-namespace',
  SECRET,
  'intent-cache',
);
const TENANT = hmacScopeDigest('tenant', SECRET, 'tenant-a');
const CACHE_KEY = `hmac-sha256:cache-key:${'5'.repeat(64)}` as CacheKeyDigest;

const ONTOLOGY: OntologyBinding = {
  id: 'test-ontology',
  version: '1',
  digest: sha256('ontology'),
};
const NORMALIZER: NormalizerBinding = {
  id: 'test-normalizer',
  version: '1',
  artifactDigest: sha256('normalizer-artifact'),
  configDigest: sha256('normalizer-config'),
};
const NORMALIZATION_POLICY_DIGEST = sha256('normalization-policy');
const CACHE_ADMISSION_POLICY_DIGEST = sha256('cache-admission-policy');
const OPERATION_REGISTRY_DIGEST = sha256('operation-registry');
const COST_MODEL_DIGEST = sha256('cost-model');
const CURRENCY_UNIT_DIGEST = sha256('currency-unit');

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function dependency(
  id: string,
  status: IntentCacheDependencyBinding['status'] = 'enabled',
): IntentCacheDependencyBinding {
  return {
    status,
    artifact: { id, version: '1', digest: sha256(`${id}:1`) },
  };
}

function dependencies(): IntentCacheDependencyInventory {
  return {
    prompt: dependency('prompt'),
    tool: dependency('tool'),
    planner: dependency('planner'),
    provider: dependency('provider'),
    model: dependency('model'),
    output: dependency('output'),
    safety: dependency('safety'),
    personalization: dependency('personalization'),
    determinism: dependency('determinism'),
    tokenizer: dependency('tokenizer'),
    embedding: dependency('embedding'),
    candidateIndex: dependency('candidate-index'),
    store: dependency('store'),
    recordAuthentication: dependency('record-authentication'),
    freshness: dependency('freshness'),
    invalidation: dependency('invalidation'),
    key: dependency('key'),
  };
}

function intent(effect: IntentEffect = 'read'): IntentIR {
  return {
    schema: INTENT_SCHEMA,
    ontology: ONTOLOGY,
    goal: {
      namespace: 'knowledge',
      action: 'explain',
      object: 'distributed-inference',
      polarity: 'affirm',
    },
    slots: [{ name: 'runtime', value: 'node' }],
    constraints: [{ path: 'deployment', operator: 'eq', value: 'local' }],
    temporal: { kind: 'none' },
    output: { format: 'markdown', locale: 'en-US', detail: 'concise' },
    effect,
  };
}

function normalization(source: string, eligible = true): NormalizationWitness {
  return createNormalizationWitness({
    sourceDigest: hmacIntentSourceDigest(SECRET, source),
    intent: intent(),
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    policyDigest: NORMALIZATION_POLICY_DIGEST,
    assessment: {
      ambiguous: !eligible,
      confidencePpm: eligible ? 990_000 : 100_000,
      minimumConfidencePpm: 950_000,
    },
    candidateEvidence: [
      {
        kind: 'embedding',
        providerId: 'test-embedding',
        evidenceDigest: sha256(`embedding:${source}`),
        scorePpm: 980_000,
        authoritative: false,
      },
    ],
  });
}

function operationBinding(
  witness: NormalizationWitness,
  effect: IntentEffect = 'read',
  operation: IntentCacheOperationHmac = OPERATION,
): IntentCacheOperationBinding {
  const value: Record<string, unknown> = {
    schema: INTENT_CACHE_OPERATION_BINDING_SCHEMA,
    operation,
    domain: DOMAIN,
    intentDigest: witness.intentDigest,
    tier: 'plan',
    effect,
    operationRegistryDigest: OPERATION_REGISTRY_DIGEST,
    ontologyDigest: ONTOLOGY.digest,
    bindingDigest: sha256('placeholder'),
  };
  value.bindingDigest = recomputeIntentCacheOperationBindingDigest(value);
  return parseIntentCacheOperationBinding(value);
}

function cacheBinding(
  witness: NormalizationWitness,
  inventory: IntentCacheDependencyInventory,
): CacheBinding {
  return {
    intentDigest: witness.intentDigest,
    normalization: {
      normalizer: witness.normalizer,
      policyDigest: witness.policyDigest,
      minimumConfidencePpm: witness.assessment.minimumConfidencePpm,
    },
    scope: {
      cacheNamespace: CACHE_NAMESPACE,
      tenant: TENANT,
      principal: hmacScopeDigest('principal', SECRET, 'principal-a'),
    },
    authorizationDigest: hmacScopeDigest('authorization', SECRET, 'reader'),
    contextDigest: hmacScopeDigest('context', SECRET, 'workspace-a'),
    policyDigest: CACHE_ADMISSION_POLICY_DIGEST,
    effect: 'read',
    tier: 'plan',
    dependencies: {
      operationRegistryDigest: OPERATION_REGISTRY_DIGEST,
      plannerDigest: inventory.planner.artifact.digest,
      toolRegistryDigest: inventory.tool.artifact.digest,
    },
  };
}

function entrySourceBinding(
  entryDigest: ReturnType<typeof sha256>,
  valueDigest: ReturnType<typeof sha256>,
  source: string,
): IntentCacheEntrySourceBinding {
  const value: Record<string, unknown> = {
    schema: INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
    entryDigest,
    valueDigest,
    entrySourceHmac: hmacIntentSourceDigest(SECRET, source),
    bindingDigest: sha256('placeholder'),
  };
  value.bindingDigest = recomputeIntentCacheEntrySourceBindingDigest(value);
  return parseIntentCacheEntrySourceBinding(value);
}

function accounting(
  completeness: IntentCacheAccountingBinding['completeness'] = 'complete',
): IntentCacheAccountingBinding {
  return completeness === 'complete'
    ? { completeness }
    : { completeness, failureDigest: sha256('accounting-failure') };
}

function usage(label: string): IntentCachePromotionUsagePair {
  const observation = (side: 'ordinary' | 'candidate') => ({
    completeness: 'complete' as const,
    traceDigest: sha256(`trace:${label}:${side}`),
    physicalInputTokens: side === 'ordinary' ? 100 : 80,
    providerPrefixCacheReadInputTokens: 0,
    providerPrefixCacheWriteInputTokens: 0,
    applicationSemanticCacheLookups: side === 'ordinary' ? 0 : 1,
    applicationSemanticCacheReads: 0,
    applicationSemanticCacheWrites: 0,
    applicationSemanticCacheInvalidations: 0,
    outputTokens: 20,
    reasoningTokens: 5,
    normalizedCostUnits: side === 'ordinary' ? 1_000 : 800,
    allocatedInvalidationCostUnits: 0,
    endToEndLatencyMicros: side === 'ordinary' ? 2_000 : 1_700,
    normalizerLatencyMicros: side === 'ordinary' ? 0 : 100,
    candidateIndexLatencyMicros: side === 'ordinary' ? 0 : 100,
    storeLatencyMicros: side === 'ordinary' ? 0 : 100,
    lookupLatencyMicros: side === 'ordinary' ? 0 : 100,
    verifierLatencyMicros: side === 'ordinary' ? 0 : 100,
    fallbackLatencyMicros: 0,
    toolCalls: 0,
    attempts: 1,
    retries: 0,
    recoveries: 0,
  });
  return {
    accounting: { completeness: 'complete' },
    costModelDigest: COST_MODEL_DIGEST,
    currencyUnitDigest: CURRENCY_UNIT_DIGEST,
    ordinary: observation('ordinary'),
    candidate: observation('candidate'),
  };
}

function incompleteUsage(label: string): IntentCachePromotionUsagePair {
  const complete = usage(label);
  const ordinaryFailureDigest = sha256(`usage-failure:${label}:ordinary`);
  return {
    accounting: {
      completeness: 'incomplete',
      failureDigest: digestIntentCachePromotionUsageFailures(
        ordinaryFailureDigest,
        null,
      ),
    },
    costModelDigest: complete.costModelDigest,
    currencyUnitDigest: complete.currencyUnitDigest,
    ordinary: {
      ...complete.ordinary,
      completeness: 'incomplete',
      failureDigest: ordinaryFailureDigest,
      reasoningTokens: null,
    },
    candidate: complete.candidate,
  };
}

function lookupReceipt(
  witness: NormalizationWitness,
  inventory: IntentCacheDependencyInventory,
  options: {
    readonly effect?: IntentEffect;
    readonly operation?: IntentCacheOperationHmac;
    readonly sideEffect?: boolean;
    readonly storeFault?: boolean;
    readonly accounting?: IntentCacheAccountingBinding;
  } = {},
): IntentCacheLookupReceipt {
  const binding = operationBinding(witness, options.effect, options.operation);
  const value: Record<string, unknown> = {
    schema: INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
    mode: 'shadow',
    applied: false,
    sourceDigest: witness.sourceDigest,
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    normalizationPolicyDigest: NORMALIZATION_POLICY_DIGEST,
    cacheAdmissionPolicyDigest: CACHE_ADMISSION_POLICY_DIGEST,
    cacheKeyDigest: CACHE_KEY,
    observedOperationBinding: binding,
    candidateIndex: inventory.candidateIndex,
    store: inventory.store,
    ...(options.sideEffect
      ? {
          outcome: 'policy-bypass',
          reason: 'ALPHA_EFFECT_FORBIDDEN',
          storeAccess: 'not-attempted',
        }
      : options.storeFault
        ? {
            outcome: 'store-fault',
            reason: 'EXPECTED_STORE_FAULT',
            storeAccess: 'attempted',
          }
        : {
            outcome: 'miss',
            reason: 'NO_CANDIDATE_FOUND',
            storeAccess: 'attempted',
          }),
    accounting: options.accounting ?? accounting(),
    receiptDigest: sha256('placeholder'),
  };
  value.receiptDigest = recomputeIntentCacheLookupReceiptDigest(value);
  return parseIntentCacheLookupReceipt(value);
}

function bypassReceipt(source: string): IntentNormalizationBypassReceipt {
  const value: Record<string, unknown> = {
    schema: INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
    mode: 'shadow',
    applied: false,
    sourceDigest: hmacIntentSourceDigest(SECRET, source),
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    normalizationPolicyDigest: NORMALIZATION_POLICY_DIGEST,
    cacheAdmissionPolicyDigest: CACHE_ADMISSION_POLICY_DIGEST,
    reason: 'INTENT_NO_MATCH',
    accounting: accounting(),
    receiptDigest: sha256('placeholder'),
  };
  value.receiptDigest = recomputeIntentNormalizationBypassReceiptDigest(value);
  return parseIntentNormalizationBypassReceipt(value);
}

function sealedCase(
  value: Record<string, unknown>,
): IntentCachePromotionEvidenceCase {
  value.caseDigest = recomputeIntentCachePromotionEvidenceCaseDigest(value);
  return value as unknown as IntentCachePromotionEvidenceCase;
}

function candidateCase(
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('explain distributed inference');
  const binding = cacheBinding(witness, inventory);
  const entry = createCacheEntry({
    valueDigest: sha256('candidate-artifact'),
    binding,
    freshness: { kind: 'ttl', createdAtEpochMs: 1_000, ttlMs: 1_000 },
  });
  const lookup = {
    binding,
    freshness: { kind: 'ttl' as const, checkedAtEpochMs: 1_500 },
  };
  const cacheHitWitness = admitCacheHit({
    entry,
    lookup,
    normalizationWitness: witness,
    sourceDigest: witness.sourceDigest,
    intent: intent(),
    expectedNormalizer: witness.normalizer,
    expectedNormalizationPolicyDigest: witness.policyDigest,
    expectedMinimumConfidencePpm: witness.assessment.minimumConfidencePpm,
  });
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'population-complete',
    ordinal: 0,
    clusterHmac: `hmac-sha256:cluster:${'a'.repeat(64)}`,
    difficulty: 'simple',
    cacheRegime: 'warm',
    pairOrder: 'ordinary-first',
    stateSnapshotDigest: sha256('state:candidate'),
    usage: usage('candidate'),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'candidate-bearing',
      normalizationWitness: witness,
      operationBinding: operationBinding(witness),
      entrySourceBinding: entrySourceBinding(
        entry.entryDigest,
        entry.valueDigest,
        'original source paraphrase',
      ),
      cacheHitWitness,
      oracle: {
        kind: 'candidate',
        ordinaryArtifactDigest: sha256('ordinary:candidate'),
        observedCandidateArtifactDigest: entry.valueDigest,
        qualityEvidenceDigest: sha256('quality:candidate'),
        artifactRelation: 'equivalent',
        scope: 'match',
        authorization: 'current-allow',
        freshness: 'fresh',
        effectTier: 'allowed',
        policy: 'allow',
        taskQuality: 'pass',
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function noCandidateCase(
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('explain model sharding');
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'population-complete',
    ordinal: 1,
    clusterHmac: `hmac-sha256:cluster:${'b'.repeat(64)}`,
    difficulty: 'medium',
    cacheRegime: 'cold',
    pairOrder: 'candidate-first',
    stateSnapshotDigest: sha256('state:no-candidate'),
    usage: usage('no-candidate'),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'normalized-no-candidate',
      normalizationWitness: witness,
      lookupReceipt: lookupReceipt(witness, inventory),
      oracle: {
        kind: 'no-candidate',
        ordinaryArtifactDigest: sha256('ordinary:no-candidate'),
        artifactRelation: 'not-comparable',
        scope: 'unknown',
        authorization: 'unknown',
        freshness: 'unknown',
        effectTier: 'unknown',
        policy: 'unknown',
        taskQuality: 'not-evaluated',
        reference: { kind: 'none' },
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function bypassCase(): IntentCachePromotionEvidenceCase {
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'population-complete',
    ordinal: 2,
    clusterHmac: `hmac-sha256:cluster:${'c'.repeat(64)}`,
    difficulty: 'complex',
    cacheRegime: 'cold',
    pairOrder: 'ordinary-first',
    stateSnapshotDigest: sha256('state:bypass'),
    usage: usage('bypass'),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'normalization-bypass',
      receipt: bypassReceipt('not an intent'),
      lookup: 'not-attempted',
      oracle: {
        kind: 'normalization-bypass',
        ordinaryArtifactDigest: sha256('ordinary:bypass'),
        artifactRelation: 'not-comparable',
        oracleOperation: { kind: 'none' },
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function populationFailureCase(): IntentCachePromotionEvidenceCase {
  const witness = normalization('population failure');
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'population-failure',
    ordinal: 3,
    clusterHmac: `hmac-sha256:cluster:${'d'.repeat(64)}`,
    difficulty: 'medium',
    cacheRegime: 'warm',
    pairOrder: 'candidate-first',
    stateSnapshotDigest: sha256('state:population-failure'),
    usage: incompleteUsage('population-failure'),
    attemptedOperation: {
      status: 'observed',
      binding: operationBinding(witness),
    },
    failure: {
      stage: 'lookup',
      reason: 'TIMEOUT',
      evidenceDigest: sha256('failure:population'),
    },
    caseDigest: sha256('placeholder'),
  });
}

function sideEffectCase(
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('delete all remote resources');
  const probe = operationBinding(witness, 'write', PROBE_OPERATION);
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-complete',
    ordinal: 4,
    primaryScenario: 'side-effect',
    phenomena: ['prompt-injection'],
    probeOperation: probe,
    difficulty: 'adversarial',
    cacheRegime: 'warm',
    pairOrder: 'ordinary-first',
    stateSnapshotDigest: sha256('state:side-effect'),
    usage: usage('side-effect'),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'normalized-no-candidate',
      normalizationWitness: witness,
      lookupReceipt: lookupReceipt(witness, inventory, {
        effect: 'write',
        operation: PROBE_OPERATION,
        sideEffect: true,
      }),
      oracle: {
        kind: 'no-candidate',
        ordinaryArtifactDigest: sha256('ordinary:side-effect'),
        artifactRelation: 'not-comparable',
        scope: 'unknown',
        authorization: 'unknown',
        freshness: 'unknown',
        effectTier: 'forbidden',
        policy: 'deny',
        taskQuality: 'not-evaluated',
        reference: { kind: 'none' },
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function adversarialFailureCase(): IntentCachePromotionEvidenceCase {
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-failure',
    ordinal: 6,
    primaryScenario: 'dependency-drift',
    phenomena: ['model-drift', 'tool-drift'],
    difficulty: 'adversarial',
    cacheRegime: 'cold',
    pairOrder: 'candidate-first',
    stateSnapshotDigest: sha256('state:adversarial-failure'),
    usage: usage('adversarial-failure'),
    attemptedOperation: { status: 'unavailable' },
    failure: {
      stage: 'candidate-index',
      reason: 'DEPENDENCY_UNAVAILABLE',
      evidenceDigest: sha256('failure:adversarial'),
    },
    caseDigest: sha256('placeholder'),
  });
}

function storeFaultCase(
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('store fault fallback');
  return sealedCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-complete',
    ordinal: 5,
    primaryScenario: 'store-fault',
    phenomena: ['invalidation-drift'],
    difficulty: 'complex',
    cacheRegime: 'warm',
    pairOrder: 'candidate-first',
    stateSnapshotDigest: sha256('state:store-fault'),
    usage: usage('store-fault'),
    storeFault: {
      kind: 'injected',
      evidenceDigest: sha256('store-fault-evidence'),
      expectedFaultObserved: true,
      ordinaryPathSucceeded: true,
      candidateFallbackSucceeded: true,
      unexpectedExecutionFailure: false,
    },
    path: {
      kind: 'normalized-no-candidate',
      normalizationWitness: witness,
      lookupReceipt: lookupReceipt(witness, inventory, { storeFault: true }),
      oracle: {
        kind: 'no-candidate',
        ordinaryArtifactDigest: sha256('ordinary:store-fault'),
        artifactRelation: 'not-comparable',
        scope: 'unknown',
        authorization: 'unknown',
        freshness: 'unknown',
        effectTier: 'unknown',
        policy: 'unknown',
        taskQuality: 'not-evaluated',
        reference: { kind: 'none' },
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function resealFixture(
  value: DeepMutable<IntentCachePromotionEvidenceFixture>,
  options: { readonly counters?: boolean } = {},
): IntentCachePromotionEvidenceFixture {
  for (const evidenceCase of value.cases) {
    evidenceCase.caseDigest =
      recomputeIntentCachePromotionEvidenceCaseDigest(evidenceCase);
  }
  const population = value.cases.filter((item) =>
    item.kind.startsWith('population-'),
  );
  const adversarial = value.cases.filter((item) =>
    item.kind.startsWith('adversarial-'),
  );
  value.binding.population.corpusDigest =
    digestIntentCachePromotionPopulationCorpus(
      population.map((item) => item.caseDigest),
    );
  value.binding.adversarial.corpusDigest =
    digestIntentCachePromotionAdversarialCorpus(
      adversarial.map((item) => item.caseDigest),
    );
  if (options.counters !== false) {
    value.binding.population.attempted = population.length;
    value.binding.population.emitted = population.length;
    value.binding.population.complete = population.filter(
      (item) => item.kind === 'population-complete',
    ).length;
    value.binding.population.failed = population.filter(
      (item) => item.kind === 'population-failure',
    ).length;
    value.binding.adversarial.expected = adversarial.length;
    value.binding.adversarial.emitted = adversarial.length;
    value.binding.adversarial.complete = adversarial.filter(
      (item) => item.kind === 'adversarial-complete',
    ).length;
    value.binding.adversarial.failed = adversarial.filter(
      (item) => item.kind === 'adversarial-failure',
    ).length;
  }
  value.binding.bindingDigest =
    recomputeIntentCachePromotionEvidenceBindingDigest(value.binding);
  return value as IntentCachePromotionEvidenceFixture;
}

function fixture(): IntentCachePromotionEvidenceFixture {
  const inventory = dependencies();
  const cases = [
    candidateCase(inventory),
    noCandidateCase(inventory),
    bypassCase(),
    populationFailureCase(),
    sideEffectCase(inventory),
    storeFaultCase(inventory),
    adversarialFailureCase(),
  ];
  const population = cases.slice(0, 4);
  const adversarial = cases.slice(4);
  const value: IntentCachePromotionEvidenceFixture = {
    binding: {
      schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
      kind: 'binding',
      artifact: {
        id: 'semwitness-intent-cache-promotion-evidence',
        version: '1',
      },
      provenance: 'host-attested-unsigned',
      evidenceAuthentication: 'none',
      activationCeiling: 'shadow-only',
      mode: 'shadow',
      tier: 'plan',
      qualifiedOperation: {
        operation: OPERATION,
        domain: DOMAIN,
        effect: 'read',
      },
      scope: {
        cacheNamespace: CACHE_NAMESPACE,
        tenant: TENANT,
        deploymentScopeDigest: sha256('deployment-scope'),
      },
      validity: {
        notBeforeEpochMs: 1_000,
        notAfterEpochMs: 2_000,
        revocationId: `hmac-sha256:revocation:${'4'.repeat(64)}`,
      },
      intentContract: {
        intentIrSchema: INTENT_SCHEMA,
        ontology: ONTOLOGY,
        normalizer: NORMALIZER,
        operationRegistry: {
          id: 'operation-registry',
          version: '1',
          digest: OPERATION_REGISTRY_DIGEST,
        },
        resolver: {
          id: 'resolver',
          version: '1',
          digest: sha256('resolver'),
        },
        normalizationPolicyDigest: NORMALIZATION_POLICY_DIGEST,
        cacheAdmissionPolicyDigest: CACHE_ADMISSION_POLICY_DIGEST,
        sourceHmacKeyVersionDigest: sha256('source-hmac-key-version'),
      },
      dependencies: inventory,
      population: {
        populationFrameDigest: sha256('population-frame'),
        corpusDigest: digestIntentCachePromotionPopulationCorpus(
          population.map((item) => item.caseDigest),
        ),
        sourceLogRootDigest: sha256('source-log-root'),
        samplingProtocolDigest: sha256('sampling-protocol'),
        inclusionPolicyDigest: sha256('inclusion-policy'),
        samplingWindowDigest: sha256('sampling-window'),
        independenceUnit: 'cluster',
        attempted: 4,
        emitted: 4,
        dropped: 0,
        complete: 3,
        failed: 1,
      },
      adversarial: {
        corpusDigest: digestIntentCachePromotionAdversarialCorpus(
          adversarial.map((item) => item.caseDigest),
        ),
        coverageDigest: sha256('coverage'),
        expected: 3,
        emitted: 3,
        complete: 2,
        failed: 1,
      },
      evaluation: {
        split: 'held-out',
        evaluationProtocolDigest: sha256('evaluation-protocol'),
        evaluatorDigest: sha256('evaluator'),
        oracleDigest: sha256('oracle'),
        accountingContractDigest: sha256('accounting-contract'),
        costModel: {
          id: 'cost-model',
          version: '1',
          digest: COST_MODEL_DIGEST,
        },
        currencyUnitDigest: CURRENCY_UNIT_DIGEST,
      },
      bindingDigest: sha256('placeholder'),
    },
    cases,
  };
  return resealFixture(mutable(value));
}

function jsonl(value: IntentCachePromotionEvidenceFixture): string {
  return [value.binding, ...value.cases]
    .map((item) => JSON.stringify(item))
    .join('\n');
}

function expectMalformed(value: unknown): void {
  expect(() => parseIntentCachePromotionEvidenceFixture(value)).toThrowError(
    expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
  );
}

function expectMutationRejected(
  mutate: (value: DeepMutable<IntentCachePromotionEvidenceFixture>) => void,
  reseal = true,
): void {
  expect(() => {
    const candidate = mutable(fixture());
    mutate(candidate);
    parseIntentCachePromotionEvidenceFixture(
      reseal ? resealFixture(candidate) : candidate,
    );
  }).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
}

describe('intent-cache promotion evidence valid boundary', () => {
  it('accepts all complete paths plus population/adversarial failures and freezes deeply', () => {
    const parsed = parseIntentCachePromotionEvidenceFixture(fixture());

    expect(parsed.cases.map((item) => item.kind)).toEqual([
      'population-complete',
      'population-complete',
      'population-complete',
      'population-failure',
      'adversarial-complete',
      'adversarial-complete',
      'adversarial-failure',
    ]);
    expect(
      parsed.cases
        .filter((item) => 'path' in item)
        .map((item) => ('path' in item ? item.path.kind : 'unreachable')),
    ).toEqual([
      'candidate-bearing',
      'normalized-no-candidate',
      'normalization-bypass',
      'normalized-no-candidate',
      'normalized-no-candidate',
    ]);
    expect(parsed.cases[3]?.usage.accounting.completeness).toBe('incomplete');
    expect(parsed.cases[5]).toMatchObject({
      storeFault: {
        kind: 'injected',
        expectedFaultObserved: true,
        ordinaryPathSucceeded: true,
        candidateFallbackSucceeded: true,
        unexpectedExecutionFailure: false,
      },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.binding.dependencies)).toBe(true);
    expect(Object.isFrozen(parsed.cases)).toBe(true);
    expect(Object.isFrozen(parsed.cases[0]?.usage.ordinary)).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.binding)).toBeNull();
    expect(Object.getPrototypeOf(parsed.cases[0])).toBeNull();
    expect(JSON.stringify(parsed)).not.toMatch(
      /raw|utterance|promptText|responseText|sourceRelation|denominator/u,
    );
  });

  it('accepts UTF-8 bytes, CRLF, and one final newline without changing order', () => {
    const source = `${jsonl(fixture()).replaceAll('\n', '\r\n')}\r\n`;
    const parsed = parseIntentCachePromotionEvidenceJsonl(
      new TextEncoder().encode(source),
    );

    expect(parsed.cases).toHaveLength(7);
    expect(parsed.cases.map((item) => item.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('accepts a fully attested no-candidate reference and derives its links', () => {
    const candidate = mutable(fixture());
    const evidenceCase = candidate.cases[1];
    if (
      evidenceCase?.kind !== 'population-complete' ||
      evidenceCase.path.kind !== 'normalized-no-candidate'
    ) {
      throw new TypeError('fixture shape changed');
    }
    const receipt = evidenceCase.path.lookupReceipt;
    const referenceArtifact = sha256('reference-artifact');
    evidenceCase.path.oracle = {
      ...evidenceCase.path.oracle,
      artifactRelation: 'equivalent',
      scope: 'match',
      authorization: 'current-allow',
      freshness: 'fresh',
      effectTier: 'allowed',
      policy: 'allow',
      reference: {
        kind: 'attested',
        artifactDigest: referenceArtifact,
        cacheKeyDigest: receipt.cacheKeyDigest,
        entrySourceBinding: entrySourceBinding(
          sha256('reference-entry'),
          referenceArtifact,
          'reference paraphrase',
        ),
        operationBinding: receipt.observedOperationBinding,
      },
    };

    const parsed = parseIntentCachePromotionEvidenceFixture(
      resealFixture(candidate),
    );
    const parsedCase = parsed.cases[1];
    expect(
      parsedCase?.kind === 'population-complete' &&
        parsedCase.path.kind === 'normalized-no-candidate'
        ? parsedCase.path.oracle.reference.kind
        : 'wrong-path',
    ).toBe('attested');
  });
});

describe('intent-cache promotion JSONL and data-only limits', () => {
  it('rejects duplicate keys, BOM, internal blanks, duplicate binding, and misplaced binding', () => {
    const valid = fixture();
    const lines = jsonl(valid).split('\n');
    const duplicateKey = lines[0]?.replace(
      '"kind":"binding"',
      '"kind":"binding","kind":"binding"',
    );
    const cases = [
      duplicateKey === undefined
        ? ''
        : [duplicateKey, ...lines.slice(1)].join('\n'),
      `\uFEFF${jsonl(valid)}`,
      `${lines[0]}\n\n${lines.slice(1).join('\n')}`,
      `${lines[0]}\n${lines[0]}\n${lines.slice(1).join('\n')}`,
      `${lines[1]}\n${lines[0]}\n${lines.slice(2).join('\n')}`,
    ];

    for (const source of cases) {
      expect(() => parseIntentCachePromotionEvidenceJsonl(source)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
      );
    }
  });

  it('rejects malformed UTF-8 bytes and ill-formed Unicode strings', () => {
    expect(() =>
      parseIntentCachePromotionEvidenceJsonl(
        Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));

    const illFormed = jsonl(fixture()).replace(
      '"version":"1"',
      `"version":"${String.fromCharCode(0xd800)}"`,
    );
    expect(() =>
      parseIntentCachePromotionEvidenceJsonl(illFormed),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects a line larger than 256 KiB and more than 50,000 cases', () => {
    const oversizedLine = `{"padding":"${'x'.repeat(256 * 1024)}"}`;
    expect(() =>
      parseIntentCachePromotionEvidenceJsonl(oversizedLine),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));

    const tooMany = mutable(fixture());
    const repeatedCase = tooMany.cases[0];
    if (repeatedCase === undefined) throw new TypeError('fixture is empty');
    tooMany.cases = Array.from({ length: 50_001 }, () => repeatedCase);
    expectMalformed(tooMany);

    const excessiveJsonl = `${JSON.stringify(fixture().binding)}\n${'{}\n'.repeat(
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES,
    )}{}`;
    expect(() =>
      parseIntentCachePromotionEvidenceJsonl(excessiveJsonl),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects a document larger than the fixed 128 MiB limit before decoding', () => {
    const oversizedDocument = new Uint8Array(128 * 1024 * 1024 + 1);

    expect(() =>
      parseIntentCachePromotionEvidenceJsonl(oversizedDocument),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects accessors without invoking them, sparse arrays, unknowns, and raw content', () => {
    let reads = 0;
    const accessor = mutable(fixture());
    Object.defineProperty(accessor.binding, 'tier', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'plan';
      },
    });
    expectMalformed(accessor);
    expect(reads).toBe(0);

    const sparse = mutable(fixture());
    const sparseCases: DeepMutable<IntentCachePromotionEvidenceCase>[] = [];
    sparseCases.length = 2;
    sparse.cases = sparseCases;
    expectMalformed(sparse);

    for (const mutate of [
      (value: DeepMutable<IntentCachePromotionEvidenceFixture>) => {
        (value as unknown as Record<string, unknown>).unknown = true;
      },
      (value: DeepMutable<IntentCachePromotionEvidenceFixture>) => {
        (value.cases[0] as unknown as Record<string, unknown>).rawUtterance =
          'secret';
      },
      (value: DeepMutable<IntentCachePromotionEvidenceFixture>) => {
        const first = value.cases[0];
        if (first?.kind === 'population-complete') {
          (first.usage as unknown as Record<string, unknown>).denominator =
            'semantic';
        }
      },
    ]) {
      const candidate = mutable(fixture());
      mutate(candidate);
      expectMalformed(candidate);
    }
  });
});

describe('intent-cache promotion ordering, counts, and uniqueness', () => {
  it('rejects ordinal gaps, kind-order swaps, and counter contradictions', () => {
    expectMutationRejected((value) => {
      const item = value.cases[2];
      if (item !== undefined) item.ordinal = 7;
    });
    expectMutationRejected((value) => {
      const firstFailure = value.cases[3];
      const lastComplete = value.cases[2];
      if (firstFailure !== undefined && lastComplete !== undefined) {
        value.cases[2] = firstFailure;
        value.cases[3] = lastComplete;
      }
    });
    expectMutationRejected((value) => {
      value.binding.population.attempted += 1;
    }, false);
    expectMutationRejected((value) => {
      value.binding.adversarial.expected += 1;
    }, false);
    expectMutationRejected((value) => {
      value.binding.population.dropped = 1 as 0;
    }, false);
  });

  it('rejects case, corpus, and binding digest tampering', () => {
    expectMutationRejected((value) => {
      const item = value.cases[0];
      if (item !== undefined) item.caseDigest = sha256('wrong-case');
    }, false);
    expectMutationRejected((value) => {
      value.binding.population.corpusDigest = sha256('wrong-corpus');
    }, false);
    expectMutationRejected((value) => {
      value.binding.bindingDigest = sha256('wrong-binding');
    }, false);
  });

  it('rejects duplicate cluster, trace, case, and quality evidence digests', () => {
    expectMutationRejected((value) => {
      const first = value.cases[0];
      const second = value.cases[1];
      if (
        first?.kind === 'population-complete' &&
        second?.kind === 'population-complete'
      ) {
        second.clusterHmac = first.clusterHmac;
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      const second = value.cases[1];
      if (first !== undefined && second !== undefined) {
        second.usage.ordinary.traceDigest = first.usage.ordinary.traceDigest;
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      const second = value.cases[1];
      if (first !== undefined && second !== undefined) {
        second.caseDigest = first.caseDigest;
      }
    }, false);
    expectMutationRejected((value) => {
      const first = value.cases[0];
      const sideEffect = value.cases[4];
      if (
        first?.kind !== 'population-complete' ||
        first.path.kind !== 'candidate-bearing' ||
        sideEffect?.kind !== 'adversarial-complete'
      ) {
        throw new TypeError('fixture shape changed');
      }
      sideEffect.path = mutable(first.path);
      sideEffect.path.oracle.qualityEvidenceDigest =
        first.path.oracle.qualityEvidenceDigest;
    });
  });

  it('rejects non-canonical or duplicate adversarial phenomenon tags', () => {
    expectMutationRejected((value) => {
      const item = value.cases[6];
      if (item?.kind === 'adversarial-failure') {
        item.phenomena = ['tool-drift', 'model-drift'];
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[6];
      if (item?.kind === 'adversarial-failure') {
        item.phenomena = ['model-drift', 'model-drift'];
      }
    });
  });
});

describe('intent-cache promotion witness and receipt cross-links', () => {
  it('rejects normalization/cache witness swaps and witness tampering', () => {
    expectMutationRejected((value) => {
      const first = value.cases[0];
      const second = value.cases[1];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing' &&
        second?.kind === 'population-complete' &&
        second.path.kind === 'normalized-no-candidate'
      ) {
        first.path.normalizationWitness = second.path.normalizationWitness;
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing'
      ) {
        first.path.normalizationWitness.intentDigest =
          sha256('tampered-intent');
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing'
      ) {
        first.path.cacheHitWitness.normalization.witnessDigest =
          sha256('swapped-witness');
      }
    });
  });

  it('rejects operation inflation, entry-source swaps, and candidate artifact mismatch', () => {
    expectMutationRejected((value) => {
      const first = value.cases[0];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing'
      ) {
        first.path.operationBinding.operation = PROBE_OPERATION;
        first.path.operationBinding.bindingDigest =
          recomputeIntentCacheOperationBindingDigest(
            first.path.operationBinding,
          );
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing'
      ) {
        first.path.entrySourceBinding.entryDigest = sha256('other-entry');
        first.path.entrySourceBinding.bindingDigest =
          recomputeIntentCacheEntrySourceBindingDigest(
            first.path.entrySourceBinding,
          );
      }
    });
    expectMutationRejected((value) => {
      const first = value.cases[0];
      if (
        first?.kind === 'population-complete' &&
        first.path.kind === 'candidate-bearing'
      ) {
        first.path.oracle.observedCandidateArtifactDigest =
          sha256('other-candidate');
      }
    });
  });

  it('rejects partial/no-candidate reference fields and candidate-only quality injection', () => {
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      (
        item.path.oracle.reference as unknown as Record<string, unknown>
      ).artifactDigest = sha256('partial-reference');
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind === 'population-complete' &&
        item.path.kind === 'normalized-no-candidate'
      ) {
        (
          item.path.oracle as unknown as Record<string, unknown>
        ).qualityEvidenceDigest = sha256('forbidden-quality');
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind === 'population-complete' &&
        item.path.kind === 'normalized-no-candidate'
      ) {
        (item.path.oracle as unknown as Record<string, unknown>).taskQuality =
          'pass';
      }
    });
  });

  it('rejects lookup receipt policy/dependency/accounting and reference cache-key mismatches', () => {
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.path.lookupReceipt.cacheAdmissionPolicyDigest =
        sha256('wrong-policy');
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.path.lookupReceipt.store = dependency('other-store');
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.path.lookupReceipt.accounting = {
        completeness: 'incomplete',
        failureDigest: sha256('receipt-accounting-failure'),
      };
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });

    expect(() => {
      const candidate = mutable(fixture());
      const item = candidate.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      const artifact = sha256('reference-artifact');
      item.path.oracle = {
        ...item.path.oracle,
        artifactRelation: 'equivalent',
        reference: {
          kind: 'attested',
          artifactDigest: artifact,
          cacheKeyDigest:
            `hmac-sha256:cache-key:${'6'.repeat(64)}` as CacheKeyDigest,
          entrySourceBinding: entrySourceBinding(
            sha256('reference-entry'),
            artifact,
            'reference source',
          ),
          operationBinding: item.path.lookupReceipt.observedOperationBinding,
        },
      };
      parseIntentCachePromotionEvidenceFixture(resealFixture(candidate));
    }).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects contradictions between normalization decisions and lookup dispositions', () => {
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.path.normalizationWitness = mutable(
        normalization('explain model sharding', false),
      );
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (
        item?.kind !== 'population-complete' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.path.lookupReceipt.outcome = 'policy-bypass';
      item.path.lookupReceipt.reason = 'NORMALIZATION_INELIGIBLE';
      item.path.lookupReceipt.storeAccess = 'not-attempted';
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });
  });
});

describe('intent-cache promotion usage and cohort cross-links', () => {
  it('rejects cost-model/currency mismatch, unsafe integers, and zero attempts', () => {
    expectMutationRejected((value) => {
      const item = value.cases[0];
      if (item !== undefined)
        item.usage.costModelDigest = sha256('other-model');
    });
    expectMutationRejected((value) => {
      const item = value.cases[0];
      if (item !== undefined)
        item.usage.currencyUnitDigest = sha256('other-currency');
    });
    expectMutationRejected((value) => {
      const item = value.cases[0];
      if (item !== undefined) {
        item.usage.ordinary.physicalInputTokens = Number.MAX_SAFE_INTEGER + 1;
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[0];
      if (item !== undefined) item.usage.candidate.attempts = 0;
    });
  });

  it('rejects incomplete accounting with contradictory failure digests', () => {
    expectMutationRejected((value) => {
      const item = value.cases[3];
      if (item === undefined) return;
      const observed = item.usage.ordinary;
      item.usage = {
        accounting: {
          completeness: 'incomplete',
          failureDigest: sha256('wrong-pair-failure'),
        },
        costModelDigest: item.usage.costModelDigest,
        currencyUnitDigest: item.usage.currencyUnitDigest,
        ordinary: {
          ...observed,
          completeness: 'incomplete',
          failureDigest: sha256('ordinary-failure'),
        },
        candidate: item.usage.candidate,
      };
    });
  });

  it('rejects population writes, non-side-effect writes, and malformed side-effect probes', () => {
    expectMutationRejected((value) => {
      const item = value.cases[3];
      if (
        item?.kind === 'population-failure' &&
        item.attemptedOperation.status === 'observed'
      ) {
        item.attemptedOperation.binding.effect = 'write';
        item.attemptedOperation.binding.bindingDigest =
          recomputeIntentCacheOperationBindingDigest(
            item.attemptedOperation.binding,
          );
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[6];
      if (item?.kind === 'adversarial-failure') {
        const witness = normalization('unexpected adversarial write');
        item.attemptedOperation = {
          status: 'observed',
          binding: operationBinding(witness, 'write', PROBE_OPERATION),
        };
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[4];
      if (
        item?.kind === 'adversarial-complete' &&
        item.primaryScenario === 'side-effect'
      ) {
        item.probeOperation.domain = `hmac-sha256:intent-domain:${'9'.repeat(64)}`;
        item.probeOperation.bindingDigest =
          recomputeIntentCacheOperationBindingDigest(item.probeOperation);
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[4];
      if (
        item?.kind === 'adversarial-complete' &&
        item.primaryScenario === 'side-effect'
      ) {
        item.probeOperation.effect = 'read';
        item.probeOperation.bindingDigest =
          recomputeIntentCacheOperationBindingDigest(item.probeOperation);
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[4];
      if (
        item?.kind !== 'adversarial-complete' ||
        item.primaryScenario !== 'side-effect' ||
        item.path.kind !== 'normalized-no-candidate'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.probeOperation.operation = OPERATION;
      item.probeOperation.bindingDigest =
        recomputeIntentCacheOperationBindingDigest(item.probeOperation);
      item.path.lookupReceipt.observedOperationBinding.operation = OPERATION;
      item.path.lookupReceipt.observedOperationBinding.bindingDigest =
        recomputeIntentCacheOperationBindingDigest(
          item.path.lookupReceipt.observedOperationBinding,
        );
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });
  });

  it('rejects contradictions between store-fault facts, receipts, and scenarios', () => {
    expectMutationRejected((value) => {
      const item = value.cases[5];
      if (item?.kind === 'adversarial-complete') {
        item.storeFault = { kind: 'not-injected' };
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[1];
      if (item?.kind === 'population-complete') {
        item.storeFault = {
          kind: 'injected',
          evidenceDigest: sha256('unexpected-observed-fault'),
          expectedFaultObserved: true,
          ordinaryPathSucceeded: true,
          candidateFallbackSucceeded: true,
          unexpectedExecutionFailure: false,
        };
      }
    });
    expectMutationRejected((value) => {
      const item = value.cases[5];
      if (
        item?.kind !== 'adversarial-complete' ||
        item.path.kind !== 'normalized-no-candidate' ||
        item.storeFault.kind !== 'injected'
      ) {
        throw new TypeError('fixture shape changed');
      }
      item.storeFault.expectedFaultObserved = false;
      item.path.lookupReceipt.outcome = 'miss';
      item.path.lookupReceipt.reason = 'NO_CANDIDATE_FOUND';
      item.path.lookupReceipt.storeAccess = 'attempted';
      item.path.lookupReceipt.receiptDigest =
        recomputeIntentCacheLookupReceiptDigest(item.path.lookupReceipt);
    });
  });

  it('keeps the evidence schema isolated from receipt and host-promotion schemas', () => {
    const candidate = mutable(fixture());
    (candidate.binding as unknown as Record<string, unknown>).schema =
      INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA;
    expectMalformed(candidate);

    const hostSchema = mutable(fixture());
    hostSchema.binding.schema =
      'semwitness.dev/host-promotion-evidence/v1alpha1' as typeof INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA;
    expectMalformed(hostSchema);
  });
});
