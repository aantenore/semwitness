// Run after `pnpm build`: node examples/intent-witness.mjs
// The fixed HMAC key is synthetic demo data. Load a deployment secret from a
// real secret manager in production and never expose it to a model.

import {
  INTENT_SCHEMA,
  admitCacheHit,
  createCacheEntry,
  createNormalizationWitness,
  hmacCacheKey,
  hmacIntentSourceDigest,
  hmacScopeDigest,
  verifyCacheHitWitness,
} from '../dist/intent/index.js';
import { sha256 } from '../dist/domain/hash.js';

const hmacSecret = new Uint8Array(32).fill(0x42);
const ontology = {
  id: 'demo-knowledge-intents',
  version: '1.0.0',
  digest: sha256('demo-knowledge-intents-v1'),
};
const normalizer = {
  id: 'caller-supplied-demo',
  version: '1.0.0',
  artifactDigest: sha256('demo-normalizer-artifact'),
  configDigest: sha256('demo-normalizer-config'),
};
const normalizationPolicyDigest = sha256('demo-normalization-policy');
const minimumConfidencePpm = 1_000_000;

const intent = {
  schema: INTENT_SCHEMA,
  ontology,
  goal: {
    namespace: 'knowledge',
    action: 'explain',
    object: 'redis-configuration',
    polarity: 'affirm',
  },
  slots: [{ name: 'technology', value: 'redis' }],
  constraints: [],
  temporal: { kind: 'none' },
  output: { format: 'markdown', locale: 'it-IT', detail: 'concise' },
  effect: 'read',
};

function normalizationWitness(source) {
  return createNormalizationWitness({
    sourceDigest: hmacIntentSourceDigest(hmacSecret, source),
    intent,
    normalizer,
    ontology,
    policyDigest: normalizationPolicyDigest,
    assessment: {
      ambiguous: false,
      confidencePpm: 1_000_000,
      minimumConfidencePpm,
    },
  });
}

const first = normalizationWitness('Spiegami come configurare Redis');
const second = normalizationWitness('Come si configura Redis?');

const binding = {
  intentDigest: first.intentDigest,
  normalization: {
    normalizer,
    policyDigest: normalizationPolicyDigest,
    minimumConfidencePpm,
  },
  scope: {
    cacheNamespace: hmacScopeDigest(
      'cache-namespace',
      hmacSecret,
      'demo-cache',
    ),
    tenant: hmacScopeDigest('tenant', hmacSecret, 'demo-tenant'),
    principal: hmacScopeDigest('principal', hmacSecret, 'demo-user'),
  },
  authorizationDigest: hmacScopeDigest(
    'authorization',
    hmacSecret,
    'knowledge:read',
  ),
  contextDigest: hmacScopeDigest(
    'context',
    hmacSecret,
    'stateless-demo-context',
  ),
  policyDigest: sha256('demo-cache-policy'),
  effect: 'read',
  tier: 'response',
  dependencies: {
    observationValueDigest: sha256('demo-redis-docs-observation'),
    outputContractDigest: sha256('demo-markdown-it-concise'),
    promptDigest: sha256('demo-response-template-v1'),
    providerDigest: sha256('demo-provider-contract-v1'),
    modelDigest: sha256('demo-model-contract-v1'),
    determinism: 'deterministic',
    determinismDigest: sha256('demo-determinism-policy-v1'),
    personalization: 'none',
    personalizationDigest: sha256('demo-no-personalization-v1'),
    safety: 'cache-eligible',
    safetyPolicyDigest: sha256('demo-safety-policy-v1'),
  },
};

const entry = createCacheEntry({
  valueDigest: sha256('synthetic-cached-answer'),
  binding,
  freshness: {
    kind: 'revision-set',
    revisions: [{ namespace: 'redis-docs', digest: sha256('redis-docs-v1') }],
  },
});
const lookup = {
  binding: { ...binding, intentDigest: second.intentDigest },
  freshness: {
    kind: 'revision-set',
    revisions: [{ namespace: 'redis-docs', digest: sha256('redis-docs-v1') }],
  },
};

const cacheHitWitness = admitCacheHit({
  entry,
  lookup,
  normalizationWitness: second,
  sourceDigest: second.sourceDigest,
  intent,
  expectedNormalizer: normalizer,
  expectedNormalizationPolicyDigest: normalizationPolicyDigest,
  expectedMinimumConfidencePpm: minimumConfidencePpm,
});
const verification = verifyCacheHitWitness(cacheHitWitness, {
  normalizationWitness: second,
  sourceDigest: second.sourceDigest,
  intent,
  expectedNormalizer: normalizer,
  expectedNormalizationPolicyDigest: normalizationPolicyDigest,
  expectedMinimumConfidencePpm: minimumConfidencePpm,
});

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'semwitness.dev/intent-demo-report/v1alpha1',
      sameIntentDigest: first.intentDigest === second.intentDigest,
      differentSourceDigest: first.sourceDigest !== second.sourceDigest,
      sameCacheKey:
        hmacCacheKey(hmacSecret, binding) ===
        hmacCacheKey(hmacSecret, lookup.binding),
      decision: cacheHitWitness.decision,
      verified: verification.verified,
      verificationReasons: verification.reasons,
      note: 'Shadow-only: no cached value was served.',
    },
    null,
    2,
  )}\n`,
);
