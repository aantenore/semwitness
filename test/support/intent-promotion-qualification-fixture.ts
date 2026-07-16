import { sha256 } from '../../src/domain/hash.js';
import {
  INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
  INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
  INTENT_CACHE_OPERATION_BINDING_SCHEMA,
  INTENT_CACHE_PROMOTION_CACHE_REGIMES,
  INTENT_CACHE_PROMOTION_DIFFICULTIES,
  INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
  INTENT_CACHE_PROMOTION_PHENOMENA,
  INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS,
  digestIntentCachePromotionAdversarialCorpus,
  digestIntentCachePromotionPopulationCorpus,
  parseIntentCacheEntrySourceBinding,
  parseIntentCacheLookupReceipt,
  parseIntentCacheOperationBinding,
  recomputeIntentCacheEntrySourceBindingDigest,
  recomputeIntentCacheLookupReceiptDigest,
  recomputeIntentCacheOperationBindingDigest,
  recomputeIntentCachePromotionEvidenceBindingDigest,
  recomputeIntentCachePromotionEvidenceCaseDigest,
  type IntentCacheDependencyBinding,
  type IntentCacheDependencyInventory,
  type IntentCacheDomainHmac,
  type IntentCacheEntrySourceBinding,
  type IntentCacheOperationBinding,
  type IntentCacheOperationHmac,
  type IntentCachePromotionEvidenceCase,
  type IntentCachePromotionEvidenceFixture,
  type IntentCachePromotionUsagePair,
  type IntentCacheRequiredAdversarialScenario,
} from '../../src/intent-host/index.js';
import {
  INTENT_SCHEMA,
  admitCacheHit,
  createCacheEntry,
  createNormalizationWitness,
  hmacIntentSourceDigest,
  hmacScopeDigest,
  type CacheBinding,
  type CacheKeyDigest,
  type IntentIR,
  type NormalizationWitness,
  type NormalizerBinding,
  type OntologyBinding,
} from '../../src/intent/index.js';

// The 2,995 unsafe opportunities need a strict safe majority in each of the
// eight value cells; round-robin allocation makes 3,003 the smallest count.
const SAFE_HIT_CASES = 3_003;
const UNSAFE_OPPORTUNITY_CASES = 2_995;
const CASES_PER_ADVERSARIAL_CELL = 5;
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

function dependency(id: string): IntentCacheDependencyBinding {
  return {
    status: 'enabled',
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

function intent(): IntentIR {
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
    effect: 'read',
  };
}

function normalization(source: string): NormalizationWitness {
  return createNormalizationWitness({
    sourceDigest: hmacIntentSourceDigest(SECRET, source),
    intent: intent(),
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    policyDigest: NORMALIZATION_POLICY_DIGEST,
    assessment: {
      ambiguous: false,
      confidencePpm: 990_000,
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
  effect: 'read' | 'write' | 'irreversible' = 'read',
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
): IntentCacheEntrySourceBinding {
  const value: Record<string, unknown> = {
    schema: INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
    entryDigest,
    valueDigest,
    entrySourceHmac: hmacIntentSourceDigest(SECRET, 'original-source'),
    bindingDigest: sha256('placeholder'),
  };
  value.bindingDigest = recomputeIntentCacheEntrySourceBindingDigest(value);
  return parseIntentCacheEntrySourceBinding(value);
}

function usage(
  label: string,
  candidateInput: number,
  candidateCost: number,
): IntentCachePromotionUsagePair {
  const observation = (
    side: 'ordinary' | 'candidate',
    physicalInputTokens: number,
    normalizedCostUnits: number,
  ) => ({
    completeness: 'complete' as const,
    traceDigest: sha256(`trace:${label}:${side}`),
    physicalInputTokens,
    providerPrefixCacheReadInputTokens: 0,
    providerPrefixCacheWriteInputTokens: 0,
    applicationSemanticCacheLookups: side === 'candidate' ? 1 : 0,
    applicationSemanticCacheReads: 0,
    applicationSemanticCacheWrites: 0,
    applicationSemanticCacheInvalidations: 0,
    outputTokens: 20,
    reasoningTokens: 5,
    normalizedCostUnits,
    allocatedInvalidationCostUnits: 0,
    endToEndLatencyMicros: 2_000,
    normalizerLatencyMicros: side === 'candidate' ? 100 : 0,
    candidateIndexLatencyMicros: side === 'candidate' ? 100 : 0,
    storeLatencyMicros: side === 'candidate' ? 100 : 0,
    lookupLatencyMicros: side === 'candidate' ? 100 : 0,
    verifierLatencyMicros: side === 'candidate' ? 100 : 0,
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
    ordinary: observation('ordinary', 100, 1_000),
    candidate: observation('candidate', candidateInput, candidateCost),
  };
}

function lookupReceipt(
  witness: NormalizationWitness,
  inventory: IntentCacheDependencyInventory,
  options: { readonly sideEffect?: boolean; readonly storeFault?: boolean },
) {
  const sideEffect = options.sideEffect === true;
  const operation = operationBinding(
    witness,
    sideEffect ? 'write' : 'read',
    sideEffect ? PROBE_OPERATION : OPERATION,
  );
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
    observedOperationBinding: operation,
    candidateIndex: inventory.candidateIndex,
    store: inventory.store,
    ...(sideEffect
      ? {
          outcome: 'policy-bypass',
          reason: 'ALPHA_EFFECT_FORBIDDEN',
          storeAccess: 'not-attempted',
        }
      : options.storeFault === true
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
    accounting: { completeness: 'complete' },
    receiptDigest: sha256('placeholder'),
  };
  value.receiptDigest = recomputeIntentCacheLookupReceiptDigest(value);
  return parseIntentCacheLookupReceipt(value);
}

function sealCase(
  value: Record<string, unknown>,
): IntentCachePromotionEvidenceCase {
  value.caseDigest = recomputeIntentCachePromotionEvidenceCaseDigest(value);
  return value as unknown as IntentCachePromotionEvidenceCase;
}

function uniqueHmac(prefix: string, label: string): string {
  return `${prefix}${sha256(label).slice('sha256:'.length)}`;
}

function candidateComponents(
  inventory: IntentCacheDependencyInventory,
  eligible: boolean,
) {
  const witness = normalization(eligible ? 'safe-lookup' : 'unsafe-lookup');
  const binding = cacheBinding(witness, inventory);
  const entry = createCacheEntry({
    valueDigest: sha256(`candidate-artifact:${eligible}`),
    binding,
    freshness: { kind: 'ttl', createdAtEpochMs: 1_000, ttlMs: 1_000 },
  });
  const cacheHitWitness = admitCacheHit({
    entry,
    lookup: {
      binding,
      freshness: {
        kind: 'ttl',
        checkedAtEpochMs: eligible ? 1_500 : 3_000,
      },
    },
    normalizationWitness: witness,
    sourceDigest: witness.sourceDigest,
    intent: intent(),
    expectedNormalizer: witness.normalizer,
    expectedNormalizationPolicyDigest: witness.policyDigest,
    expectedMinimumConfidencePpm: witness.assessment.minimumConfidencePpm,
  });
  return {
    normalizationWitness: witness,
    operationBinding: operationBinding(witness),
    entrySourceBinding: entrySourceBinding(
      entry.entryDigest,
      entry.valueDigest,
    ),
    cacheHitWitness,
    valueDigest: entry.valueDigest,
  };
}

function candidateOracle(
  scenario: IntentCacheRequiredAdversarialScenario | 'safe-population',
  ordinal: number,
  valueDigest: ReturnType<typeof sha256>,
) {
  const base = {
    kind: 'candidate' as const,
    ordinaryArtifactDigest: sha256(`ordinary:${ordinal}`),
    observedCandidateArtifactDigest: valueDigest,
    qualityEvidenceDigest: sha256(`quality:${ordinal}`),
    artifactRelation: 'equivalent' as const,
    scope: 'match' as const,
    authorization: 'current-allow' as const,
    freshness: 'fresh' as const,
    effectTier: 'allowed' as const,
    policy: 'allow' as const,
    taskQuality: 'pass' as const,
  };
  switch (scenario) {
    case 'safe-population':
    case 'equivalent-paraphrase':
      return base;
    case 'distinct-near-miss':
      return { ...base, artifactRelation: 'different' as const };
    case 'cross-tenant':
    case 'context-drift':
      return { ...base, scope: 'mismatch' as const };
    case 'authorization-drift':
      return { ...base, authorization: 'deny' as const };
    case 'stale':
      return { ...base, freshness: 'stale' as const };
    case 'dependency-drift':
      return { ...base, policy: 'deny' as const };
    default:
      throw new TypeError(`Scenario ${scenario} is not candidate-bearing`);
  }
}

function candidateCase(options: {
  readonly ordinal: number;
  readonly scenario: IntentCacheRequiredAdversarialScenario | 'safe-population';
  readonly difficulty: (typeof INTENT_CACHE_PROMOTION_DIFFICULTIES)[number];
  readonly cacheRegime: (typeof INTENT_CACHE_PROMOTION_CACHE_REGIMES)[number];
  readonly components: ReturnType<typeof candidateComponents>;
  readonly population: boolean;
  readonly phenomena?: readonly (typeof INTENT_CACHE_PROMOTION_PHENOMENA)[number][];
  readonly apparentSavings?: boolean;
}): IntentCachePromotionEvidenceCase {
  const { ordinal, scenario, difficulty, cacheRegime, components, population } =
    options;
  const semanticallySafe =
    scenario === 'safe-population' || scenario === 'equivalent-paraphrase';
  const apparentSavings = options.apparentSavings ?? semanticallySafe;
  return sealCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: population ? 'population-complete' : 'adversarial-complete',
    ordinal,
    ...(population
      ? {
          clusterHmac: uniqueHmac('hmac-sha256:cluster:', `cluster:${ordinal}`),
        }
      : {
          primaryScenario: scenario,
          phenomena: options.phenomena ?? INTENT_CACHE_PROMOTION_PHENOMENA,
        }),
    difficulty,
    cacheRegime,
    pairOrder: ordinal % 2 === 0 ? 'ordinary-first' : 'candidate-first',
    stateSnapshotDigest: sha256(`state:${ordinal}`),
    usage: usage(
      `case:${ordinal}`,
      apparentSavings ? 50 : 100,
      apparentSavings ? 500 : 1_000,
    ),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'candidate-bearing',
      normalizationWitness: components.normalizationWitness,
      operationBinding: components.operationBinding,
      entrySourceBinding: components.entrySourceBinding,
      cacheHitWitness: components.cacheHitWitness,
      oracle: candidateOracle(scenario, ordinal, components.valueDigest),
    },
    caseDigest: sha256('placeholder'),
  });
}

function sideEffectCase(
  ordinal: number,
  difficulty: (typeof INTENT_CACHE_PROMOTION_DIFFICULTIES)[number],
  cacheRegime: (typeof INTENT_CACHE_PROMOTION_CACHE_REGIMES)[number],
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('side-effect-probe');
  return sealCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-complete',
    ordinal,
    primaryScenario: 'side-effect',
    phenomena: INTENT_CACHE_PROMOTION_PHENOMENA,
    probeOperation: operationBinding(witness, 'write', PROBE_OPERATION),
    difficulty,
    cacheRegime,
    pairOrder: ordinal % 2 === 0 ? 'ordinary-first' : 'candidate-first',
    stateSnapshotDigest: sha256(`state:${ordinal}`),
    usage: usage(`case:${ordinal}`, 100, 1_000),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'normalized-no-candidate',
      normalizationWitness: witness,
      lookupReceipt: lookupReceipt(witness, inventory, { sideEffect: true }),
      oracle: {
        kind: 'no-candidate',
        ordinaryArtifactDigest: sha256(`ordinary:${ordinal}`),
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

function storeFaultCase(
  ordinal: number,
  difficulty: (typeof INTENT_CACHE_PROMOTION_DIFFICULTIES)[number],
  cacheRegime: (typeof INTENT_CACHE_PROMOTION_CACHE_REGIMES)[number],
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('store-fault-probe');
  return sealCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-complete',
    ordinal,
    primaryScenario: 'store-fault',
    phenomena: INTENT_CACHE_PROMOTION_PHENOMENA,
    difficulty,
    cacheRegime,
    pairOrder: ordinal % 2 === 0 ? 'ordinary-first' : 'candidate-first',
    stateSnapshotDigest: sha256(`state:${ordinal}`),
    usage: usage(`case:${ordinal}`, 100, 1_000),
    storeFault: {
      kind: 'injected',
      evidenceDigest: sha256(`store-fault:${ordinal}`),
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
        ordinaryArtifactDigest: sha256(`ordinary:${ordinal}`),
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

function distinctMissCase(
  ordinal: number,
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceCase {
  const witness = normalization('distinct-miss');
  const observedOperation = operationBinding(witness);
  const reference = entrySourceBinding(
    sha256('distinct-reference-entry'),
    sha256('distinct-reference-artifact'),
  );
  return sealCase({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'adversarial-complete',
    ordinal,
    primaryScenario: 'distinct-near-miss',
    phenomena: ['negation'],
    difficulty: 'simple',
    cacheRegime: 'cold',
    pairOrder: 'ordinary-first',
    stateSnapshotDigest: sha256(`state:${ordinal}`),
    usage: usage(`case:${ordinal}`, 100, 1_000),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'normalized-no-candidate',
      normalizationWitness: witness,
      lookupReceipt: lookupReceipt(witness, inventory, {}),
      oracle: {
        kind: 'no-candidate',
        ordinaryArtifactDigest: sha256(`ordinary:${ordinal}`),
        artifactRelation: 'different',
        scope: 'match',
        authorization: 'current-allow',
        freshness: 'fresh',
        effectTier: 'allowed',
        policy: 'allow',
        taskQuality: 'not-evaluated',
        reference: {
          kind: 'attested',
          artifactDigest: reference.valueDigest,
          cacheKeyDigest: CACHE_KEY,
          entrySourceBinding: reference,
          operationBinding: observedOperation,
        },
      },
    },
    caseDigest: sha256('placeholder'),
  });
}

function fixtureFromCases(
  cases: readonly IntentCachePromotionEvidenceCase[],
  inventory: IntentCacheDependencyInventory,
): IntentCachePromotionEvidenceFixture {
  const population = cases.filter((item) =>
    item.kind.startsWith('population-'),
  );
  const adversarial = cases.filter((item) =>
    item.kind.startsWith('adversarial-'),
  );
  const fixture: IntentCachePromotionEvidenceFixture = {
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
        attempted: population.length,
        emitted: population.length,
        dropped: 0,
        complete: population.length,
        failed: 0,
      },
      adversarial: {
        corpusDigest: digestIntentCachePromotionAdversarialCorpus(
          adversarial.map((item) => item.caseDigest),
        ),
        coverageDigest: sha256('coverage'),
        expected: adversarial.length,
        emitted: adversarial.length,
        complete: adversarial.length,
        failed: 0,
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
  (
    fixture.binding as { bindingDigest: ReturnType<typeof sha256> }
  ).bindingDigest = recomputeIntentCachePromotionEvidenceBindingDigest(
    fixture.binding,
  );
  return fixture;
}

export function createEmptyIntentPromotionFixture(): IntentCachePromotionEvidenceFixture {
  return fixtureFromCases([], dependencies());
}

export function createUnsafeHitIntentPromotionFixture(): IntentCachePromotionEvidenceFixture {
  const inventory = dependencies();
  return fixtureFromCases(
    [
      candidateCase({
        ordinal: 0,
        scenario: 'distinct-near-miss',
        difficulty: 'simple',
        cacheRegime: 'cold',
        components: candidateComponents(inventory, true),
        population: true,
        apparentSavings: true,
      }),
    ],
    inventory,
  );
}

export function createDistinctIntentPromotionFixture(
  disposition: 'candidate-bypass' | 'miss',
): IntentCachePromotionEvidenceFixture {
  const inventory = dependencies();
  const item =
    disposition === 'miss'
      ? distinctMissCase(0, inventory)
      : candidateCase({
          ordinal: 0,
          scenario: 'distinct-near-miss',
          difficulty: 'simple',
          cacheRegime: 'cold',
          components: candidateComponents(inventory, false),
          population: false,
          phenomena: ['negation'],
        });
  return fixtureFromCases([item], inventory);
}

export function createSideEffectIntentPromotionFixture(
  includeProbe = true,
): IntentCachePromotionEvidenceFixture {
  const inventory = dependencies();
  const item = sideEffectCase(0, 'simple', 'cold', inventory);
  if (!includeProbe) {
    delete (item as unknown as { probeOperation?: unknown }).probeOperation;
  }
  return fixtureFromCases([item], inventory);
}

export function createQualifyingIntentPromotionFixture(): IntentCachePromotionEvidenceFixture {
  const inventory = dependencies();
  const eligible = candidateComponents(inventory, true);
  const bypassed = candidateComponents(inventory, false);
  if (
    eligible.cacheHitWitness.decision.verdict !== 'eligible' ||
    bypassed.cacheHitWitness.decision.verdict !== 'bypass'
  ) {
    throw new TypeError('Qualification fixture admission setup is invalid');
  }

  const cases: IntentCachePromotionEvidenceCase[] = [];
  const cells = INTENT_CACHE_PROMOTION_DIFFICULTIES.flatMap((difficulty) =>
    INTENT_CACHE_PROMOTION_CACHE_REGIMES.map((cacheRegime) => ({
      difficulty,
      cacheRegime,
    })),
  );
  for (let index = 0; index < SAFE_HIT_CASES; index += 1) {
    const cell = cells[index % cells.length]!;
    cases.push(
      candidateCase({
        ordinal: cases.length,
        scenario: 'safe-population',
        difficulty: cell.difficulty,
        cacheRegime: cell.cacheRegime,
        components: eligible,
        population: true,
      }),
    );
  }
  for (let index = 0; index < UNSAFE_OPPORTUNITY_CASES; index += 1) {
    const cell = cells[index % cells.length]!;
    cases.push(
      candidateCase({
        ordinal: cases.length,
        scenario: 'distinct-near-miss',
        difficulty: cell.difficulty,
        cacheRegime: cell.cacheRegime,
        components: bypassed,
        population: true,
      }),
    );
  }
  for (const scenario of INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS) {
    for (const difficulty of INTENT_CACHE_PROMOTION_DIFFICULTIES) {
      for (const cacheRegime of INTENT_CACHE_PROMOTION_CACHE_REGIMES) {
        for (let sample = 0; sample < CASES_PER_ADVERSARIAL_CELL; sample += 1) {
          const ordinal = cases.length;
          if (scenario === 'side-effect') {
            cases.push(
              sideEffectCase(ordinal, difficulty, cacheRegime, inventory),
            );
          } else if (scenario === 'store-fault') {
            cases.push(
              storeFaultCase(ordinal, difficulty, cacheRegime, inventory),
            );
          } else {
            cases.push(
              candidateCase({
                ordinal,
                scenario,
                difficulty,
                cacheRegime,
                components:
                  scenario === 'equivalent-paraphrase' ? eligible : bypassed,
                population: false,
              }),
            );
          }
        }
      }
    }
  }

  return fixtureFromCases(cases, inventory);
}
