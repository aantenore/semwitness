import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  HOST_PREPARER_ARTIFACT,
  type HostPromotionManifest,
} from '../src/host/index.js';
import {
  INTENT_CACHE_PROMOTION_CACHE_REGIMES,
  INTENT_CACHE_PROMOTION_DIFFICULTIES,
  INTENT_CACHE_PROMOTION_SOURCE_RELATIONS,
  INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS,
  INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT,
  INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
  REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
  REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS,
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheShadowQualificationManifest,
  type IntentCacheBoundArtifact,
  type IntentCacheDependencyBinding,
  type IntentCacheDomainHmac,
  type IntentCacheOperationHmac,
  type IntentCacheShadowQualificationManifest,
} from '../src/intent-host/index.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const DOMAIN =
  `hmac-sha256:intent-domain:${'1'.repeat(64)}` as IntentCacheDomainHmac;
const OPERATION =
  `hmac-sha256:operation:${'2'.repeat(64)}` as IntentCacheOperationHmac;
const OTHER_DOMAIN =
  `hmac-sha256:intent-domain:${'6'.repeat(64)}` as IntentCacheDomainHmac;
const OTHER_OPERATION =
  `hmac-sha256:operation:${'7'.repeat(64)}` as IntentCacheOperationHmac;

function artifact(id: string): IntentCacheBoundArtifact {
  return {
    id,
    version: '1',
    digest: sha256(`${id}:1`),
  };
}

function binding(
  id: string,
  status: IntentCacheDependencyBinding['status'] = 'enabled',
): IntentCacheDependencyBinding {
  return { status, artifact: artifact(id) };
}

function fixture(): IntentCacheShadowQualificationManifest {
  return {
    schema: INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
    artifact: { ...INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT },
    provenance: 'host-attested-unsigned',
    evidenceAuthentication: 'none',
    producerIdentity: null,
    activationCeiling: 'shadow-only',
    validity: {
      notBeforeEpochMs: 1,
      notAfterEpochMs: 2,
      revocationId: `hmac-sha256:revocation:${'3'.repeat(64)}`,
    },
    tier: 'plan',
    effect: 'read',
    candidateOrigin: 'normalized-intent',
    deploymentScopeDigest: sha256('deployment-scope'),
    scope: {
      cacheNamespace: `hmac-sha256:cache-namespace:${'4'.repeat(64)}`,
      tenant: `hmac-sha256:tenant:${'5'.repeat(64)}`,
      domain: DOMAIN,
      operation: {
        operation: OPERATION,
        domain: DOMAIN,
        independentNormalizedIntentWouldHits: 2_995,
        oraclePermittedEquivalentOpportunities: 2_995,
        normalizedIntentCoveragePpm: 1_000_000,
      },
    },
    intentContract: {
      intentIrSchema: 'semwitness.dev/intent-ir/v1alpha1',
      ontology: {
        id: 'test-ontology',
        version: '1',
        digest: sha256('test-ontology:1'),
      },
      normalizer: {
        id: 'test-normalizer',
        version: '1',
        artifactDigest: sha256('test-normalizer:1'),
        configDigest: sha256('test-normalizer-config:1'),
      },
      operationRegistry: {
        id: 'test-operation-registry',
        version: '1',
        digest: sha256('test-operation-registry:1'),
      },
      resolver: {
        id: 'test-resolver',
        version: '1',
        digest: sha256('test-resolver:1'),
      },
      normalizationPolicyDigest: sha256('normalization-policy'),
      cacheAdmissionPolicyDigest: sha256('cache-admission-policy'),
    },
    dependencies: {
      prompt: binding('prompt'),
      tool: binding('tool'),
      planner: binding('planner'),
      provider: binding('provider'),
      model: binding('model'),
      output: binding('output'),
      safety: binding('safety'),
      personalization: binding('disabled-personalization', 'disabled'),
      determinism: binding('determinism'),
      tokenizer: binding('tokenizer'),
      embedding: binding('embedding'),
      candidateIndex: binding('candidate-index'),
      store: binding('store'),
      recordAuthentication: binding('record-authentication'),
      freshness: binding('freshness'),
      invalidation: binding('invalidation'),
      key: binding('key'),
    },
    population: {
      populationFrameDigest: sha256('population-frame'),
      corpusDigest: sha256('population-corpus'),
      sourceLogRootDigest: sha256('source-log-root'),
      samplingProtocolDigest: sha256('sampling-protocol'),
      inclusionPolicyDigest: sha256('inclusion-policy'),
      samplingWindowDigest: sha256('sampling-window'),
      attempted: 5_990,
      emitted: 5_990,
      dropped: 0,
      complete: 5_990,
      failed: 0,
      uniqueClusters: 5_990,
      exactSourceWouldHits: 0,
      normalizedIntentWouldHits: 2_995,
      misses: 0,
      bypasses: 2_995,
    },
    adversarial: {
      corpusDigest: sha256('adversarial-corpus'),
      coverageDigest: sha256('adversarial-coverage'),
      expectedCases: 360,
      emittedCases: 360,
      failedCases: 0,
      requiredIntersections:
        REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
      minimumCasesPerIntersection: 5,
      truthTableViolations: 0,
      unexpectedExecutionFailures: 0,
    },
    statisticalClaims: {
      falseDiscoveryRate: {
        failures: 0,
        trials: 2_995,
        upperBound95Ppm: 1_000,
        ceilingPpm: 1_000,
      },
      unsafeAdmissionRate: {
        failures: 0,
        trials: 2_995,
        upperBound95Ppm: 1_000,
        ceilingPpm: 1_000,
      },
      falseMissRate: {
        missesOrBypasses: 0,
        oraclePermittedEquivalentOpportunities: 2_995,
        observedRatePpm: 0,
      },
    },
    value: {
      medianNetSavingsRatioPpm: 100_000,
      aggregateNetSavingsRatioPpm: 100_000,
      p10NetSavingsRatioPpm: 0,
      maximumCaseNetRegressionRatioPpm: 0,
      criticalIntersectionsDigest: sha256('critical-intersections'),
      criticalIntersections:
        REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS,
      minimumCasesPerCriticalIntersection: 5,
      minimumWouldHitsPerCriticalIntersection: 5,
      minimumCriticalMedianNetSavingsRatioPpm: 100_000,
      minimumCriticalAggregateNetSavingsRatioPpm: 100_000,
      minimumCriticalP10NetSavingsRatioPpm: 0,
      maximumCriticalCaseNetRegressionRatioPpm: 0,
    },
    mandatoryBypassOverhead: {
      medianCostOverheadRatioPpm: 0,
      aggregateCostOverheadRatioPpm: 0,
      medianLatencyOverheadRatioPpm: 0,
      aggregateLatencyOverheadRatioPpm: 0,
    },
    evidence: {
      evaluationProtocolDigest: sha256('evaluation-protocol'),
      evaluatorDigest: sha256('evaluator'),
      oracleDigest: sha256('oracle'),
      costModelDigest: sha256('cost-model'),
      accountingContractDigest: sha256('accounting-contract'),
      reportDigest: sha256('report'),
    },
  };
}

function mutableFixture(): DeepMutable<IntentCacheShadowQualificationManifest> {
  return structuredClone(
    fixture(),
  ) as unknown as DeepMutable<IntentCacheShadowQualificationManifest>;
}

function expectMalformed(candidate: unknown): void {
  expect(() =>
    parseIntentCacheShadowQualificationManifest(candidate),
  ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
}

describe('intent-cache shadow qualification manifest', () => {
  it('parses, deeply freezes and deterministically hashes the frozen alpha scope', () => {
    const parsed = parseIntentCacheShadowQualificationManifest(fixture());
    const reordered = Object.fromEntries(Object.entries(fixture()).reverse());

    expect(parsed).toEqual(fixture());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scope)).toBe(true);
    expect(Object.isFrozen(parsed.scope.operation)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies.prompt)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies.prompt.artifact)).toBe(true);
    expect(parsed.dependencies.personalization.status).toBe('disabled');
    expect(digestIntentCacheShadowQualificationManifest(parsed)).toBe(
      digestIntentCacheShadowQualificationManifest(reordered),
    );
    expect(REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS).toBe(
      INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS.length *
        INTENT_CACHE_PROMOTION_DIFFICULTIES.length *
        INTENT_CACHE_PROMOTION_CACHE_REGIMES.length,
    );
    expect(REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS).toBe(
      INTENT_CACHE_PROMOTION_DIFFICULTIES.length *
        INTENT_CACHE_PROMOTION_CACHE_REGIMES.length,
    );
    expect(INTENT_CACHE_PROMOTION_SOURCE_RELATIONS).toEqual([
      'exact-source',
      'normalized-intent',
    ]);
  });

  it('rejects every not-applicable dependency slot', () => {
    for (const dependency of Object.keys(fixture().dependencies)) {
      const candidate = mutableFixture();
      const dependencies = candidate.dependencies as unknown as Record<
        string,
        unknown
      >;
      const original =
        fixture().dependencies[
          dependency as keyof IntentCacheShadowQualificationManifest['dependencies']
        ];
      dependencies[dependency] = {
        status: 'not-applicable',
        artifact: original.artifact,
      };

      expectMalformed(candidate);
    }
  });

  it('rejects array-shaped operation or domain scope inflation', () => {
    const operationArray = mutableFixture();
    const operationScope = operationArray.scope as unknown as Record<
      string,
      unknown
    >;
    operationScope.operation = [
      fixture().scope.operation,
      {
        ...fixture().scope.operation,
        operation: OTHER_OPERATION,
      },
    ];

    const domainArray = mutableFixture();
    const domainScope = domainArray.scope as unknown as Record<string, unknown>;
    domainScope.domain = [DOMAIN, OTHER_DOMAIN];

    expectMalformed(operationArray);
    expectMalformed(domainArray);
  });

  it('rejects any producer-selected critical-intersection count', () => {
    for (const criticalIntersections of [7, 9]) {
      const candidate = mutableFixture();
      const value = candidate.value as unknown as Record<string, unknown>;
      value.criticalIntersections = criticalIntersections;

      expectMalformed(candidate);
    }
  });

  it('rejects population failures even when counters retain them', () => {
    const candidate = mutableFixture();
    const population = candidate.population as unknown as {
      failed: number;
      complete: number;
      bypasses: number;
    };
    population.failed = 1;
    population.complete -= 1;
    population.bypasses -= 1;

    expectMalformed(candidate);
  });

  it('rejects repeated-cluster population counters', () => {
    const candidate = mutableFixture();
    candidate.population.uniqueClusters -= 1;

    expectMalformed(candidate);
  });

  it('rejects permitted opportunities that hide unreported false misses', () => {
    const candidate = mutableFixture();
    candidate.scope.operation.oraclePermittedEquivalentOpportunities = 4_000;
    candidate.scope.operation.normalizedIntentCoveragePpm = 748_750;
    candidate.statisticalClaims.falseMissRate.oraclePermittedEquivalentOpportunities = 4_000;
    candidate.population.attempted = 6_995;
    candidate.population.emitted = 6_995;
    candidate.population.complete = 6_995;
    candidate.population.uniqueClusters = 6_995;
    candidate.population.bypasses = 4_000;

    expectMalformed(candidate);
  });

  it('rejects unsafe-opportunity trials padded by exact-source hits', () => {
    const candidate = mutableFixture();
    candidate.statisticalClaims.unsafeAdmissionRate.trials = 4_000;
    candidate.statisticalClaims.unsafeAdmissionRate.upperBound95Ppm = 749;
    candidate.population.attempted = 6_995;
    candidate.population.emitted = 6_995;
    candidate.population.complete = 6_995;
    candidate.population.uniqueClusters = 6_995;
    candidate.population.exactSourceWouldHits = 1_005;

    expectMalformed(candidate);
  });

  it('rejects observation, response and non-alpha qualification modes', () => {
    for (const [field, value] of [
      ['tier', 'observation'],
      ['tier', 'response'],
      ['effect', 'write'],
      ['candidateOrigin', 'exact-source'],
      ['activationCeiling', 'active'],
    ] as const) {
      const candidate = mutableFixture() as unknown as Record<string, unknown>;
      candidate[field] = value;

      expectMalformed(candidate);
    }
  });

  it('rejects a compression-host promotion manifest', () => {
    const compressionManifest: HostPromotionManifest = {
      schema: 'semwitness.dev/host-promotion/v1alpha1',
      artifact: { ...HOST_PREPARER_ARTIFACT },
      policyDigest: sha256('compression-policy'),
      deploymentScopeDigest: sha256('compression-deployment'),
      tokenizer: { id: 'tokenizer', fingerprint: 'tokenizer:fingerprint' },
      codecs: [{ id: 'json-jcs', version: '1' }],
      evaluation: {
        corpusDigest: sha256('compression-corpus'),
        reportDigest: sha256('compression-report'),
        split: 'held-out',
        unsafeAccepts: 0,
        taskQualityRegressions: 0,
        medianNetSavingsRatioPpm: 100_000,
      },
    };

    expectMalformed(compressionManifest);
  });

  it('rejects a padded adversarial-intersection counter', () => {
    const candidate = mutableFixture();
    candidate.adversarial.requiredIntersections += 1;
    candidate.adversarial.expectedCases += 5;
    candidate.adversarial.emittedCases += 5;

    expectMalformed(candidate);
  });

  it('rejects adversarial coverage below every required intersection', () => {
    const candidate = mutableFixture();
    candidate.adversarial.expectedCases -= 1;
    candidate.adversarial.emittedCases -= 1;

    expectMalformed(candidate);
  });

  it('rejects unknown, hidden and symbol fields', () => {
    const unknown = {
      ...fixture(),
      rawPrompt: 'must-not-be-accepted',
    };
    const hidden = mutableFixture() as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, 'hidden', {
      enumerable: false,
      value: 'must-not-be-accepted',
    });
    const symbol = mutableFixture() as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol('raw-prompt')] = 'must-not-be-accepted';

    expectMalformed(unknown);
    expectMalformed(hidden);
    expectMalformed(symbol);
    expect(() =>
      digestIntentCacheShadowQualificationManifest(unknown),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects accessors without invoking them', () => {
    let reads = 0;
    const candidate = mutableFixture();
    Object.defineProperty(candidate, 'deploymentScopeDigest', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return sha256('accessor-value');
      },
    });

    expectMalformed(candidate);
    expect(() =>
      digestIntentCacheShadowQualificationManifest(candidate),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
    expect(reads).toBe(0);
  });

  it('rejects sparse and accessor-backed values in scalar scope fields', () => {
    const sparseCandidate = mutableFixture();
    const sparse: unknown[] = [];
    sparse.length = 1;
    (sparseCandidate.scope as unknown as Record<string, unknown>).operation =
      sparse;

    let reads = 0;
    const accessorCandidate = mutableFixture();
    Object.defineProperty(accessorCandidate.scope, 'operation', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return fixture().scope.operation;
      },
    });

    expectMalformed(sparseCandidate);
    expectMalformed(accessorCandidate);
    expect(reads).toBe(0);
  });
});
