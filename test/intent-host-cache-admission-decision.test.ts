import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
  hmacCacheArtifactCommitments,
  parseCacheHitWitnessArtifact,
  serializeCacheHitWitnessArtifact,
} from '../src/intent/index.js';
import {
  INTENT_CACHE_ADMISSION_DECISION_ARTIFACT,
  INTENT_CACHE_ADMISSION_DECISION_DSSE_PAYLOAD_TYPE,
  INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME,
  INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE,
  INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME,
  MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
  MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES,
  MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES,
  createIntentCacheAdmissionDecisionStatement,
  createIntentCacheAdmissionPassportStatement,
  digestIntentCacheAdmissionDecisionCanonicalProfile,
  parseIntentCacheAdmissionDecisionStatement,
  parseIntentCacheEntrySourceBinding,
  parseIntentCacheOperationBinding,
  parseIntentCacheShadowQualificationManifest,
  recomputeIntentCacheEntrySourceBindingDigest,
  recomputeIntentCacheOperationBindingDigest,
  serializeIntentCacheAdmissionDecisionStatement,
  serializeIntentCacheAdmissionPassportStatement,
  verifyIntentCacheAdmissionDecisionStatementBinding,
  type IntentCacheAdmissionDecisionEvidence,
  type IntentCacheAdmissionDecisionStatement,
} from '../src/intent-host/index.js';
import { createUnsafeHitIntentPromotionFixture } from './support/intent-promotion-qualification-fixture.js';

const CACHE_KEY_SECRET = '0123456789abcdef0123456789abcdef';
const CANDIDATE_VALUE = 'candidate-artifact:true';
const GOLDEN_DECISION_DIGEST =
  'sha256:cd59cc61a2f8a755edf8fb31886c438bf0f2def597e02849734db4c51bfd9187';
const GOLDEN_PASSPORT_PAYLOAD_DIGEST =
  'sha256:323b9a45fccd2b3e42c06d448c24c7adf1e340ca3f7ce0753882aba4bf611287';
const GOLDEN_WITNESS_PAYLOAD_DIGEST =
  'sha256:7c55148aab7ffd712a7125ab9df2a596076acd01efa087ff49a410a4453fdc4c';

let evidence: IntentCacheAdmissionDecisionEvidence;
let statement: IntentCacheAdmissionDecisionStatement;
let serialized: string;

function mutable<T>(value: T): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function mutableStatement(): Record<string, any> {
  return JSON.parse(serialized) as Record<string, any>;
}

function withEvidence(
  overrides: Partial<IntentCacheAdmissionDecisionEvidence>,
): IntentCacheAdmissionDecisionEvidence {
  return { ...evidence, ...overrides };
}

function withChangedQualification(
  mutate: (qualification: Record<string, any>) => void,
): IntentCacheAdmissionDecisionEvidence {
  const changed = mutable(evidence.qualification);
  mutate(changed);
  const qualification = parseIntentCacheShadowQualificationManifest(changed);
  const passport = serializeIntentCacheAdmissionPassportStatement(
    createIntentCacheAdmissionPassportStatement(qualification),
  );
  return withEvidence({ qualification, passport });
}

function mismatchedOperationBinding(): unknown {
  const changed = mutable(evidence.operationBinding);
  changed.domain = `hmac-sha256:intent-domain:${'9'.repeat(64)}`;
  changed.bindingDigest = recomputeIntentCacheOperationBindingDigest(changed);
  return parseIntentCacheOperationBinding(changed);
}

function mismatchedEntrySourceBinding(): unknown {
  const changed = mutable(evidence.entrySourceBinding);
  changed.entryDigest = sha256('different-cache-entry');
  changed.bindingDigest = recomputeIntentCacheEntrySourceBindingDigest(changed);
  return parseIntentCacheEntrySourceBinding(changed);
}

beforeAll(async () => {
  const qualification = parseIntentCacheShadowQualificationManifest(
    JSON.parse(
      await readFile(
        new URL(
          './fixtures/intent-cache-shadow-qualification.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
  const passport = serializeIntentCacheAdmissionPassportStatement(
    createIntentCacheAdmissionPassportStatement(qualification),
  );
  const fixture = createUnsafeHitIntentPromotionFixture();
  const candidate = fixture.cases[0];
  if (
    candidate === undefined ||
    (candidate.kind !== 'population-complete' &&
      candidate.kind !== 'adversarial-complete') ||
    candidate.path.kind !== 'candidate-bearing'
  ) {
    throw new TypeError('Expected one candidate-bearing admission fixture');
  }

  evidence = {
    passport,
    qualification,
    cacheHitWitness: serializeCacheHitWitnessArtifact(
      candidate.path.cacheHitWitness,
    ),
    normalizationWitness: candidate.path.normalizationWitness,
    operationBinding: candidate.path.operationBinding,
    entrySourceBinding: candidate.path.entrySourceBinding,
    cacheKeySecret: CACHE_KEY_SECRET,
    value: CANDIDATE_VALUE,
  };
  statement = createIntentCacheAdmissionDecisionStatement(evidence);
  serialized = serializeIntentCacheAdmissionDecisionStatement(statement);
});

describe('intent-cache Admission Decision Statement', () => {
  it('creates deterministic golden bytes for an eligible plan-read candidate', () => {
    expect(statement).toMatchObject({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE,
      predicate: {
        artifact: INTENT_CACHE_ADMISSION_DECISION_ARTIFACT,
        profile: 'intent-plan-read',
        authentication: 'none',
        mode: 'shadow',
        activationCeiling: 'shadow-only',
        decision: {
          verdict: 'eligible',
          applied: false,
          reasons: ['CACHE_HIT_ELIGIBLE'],
        },
        servingAuthority: 'none',
        candidate: {
          cacheKeyDigest:
            'hmac-sha256:cache-key:6a9170f540b5622103b1414ff4d7a61efcd46af08f8fc4ec817ac06dbe413ecb',
          entryCommitment:
            'hmac-sha256:cache-entry:ec77af90dfce47793a5c916ef2d2f995fb7cb6bf756dbec7d195fa421b30e42f',
          valueCommitment:
            'hmac-sha256:cache-value:6465bc2bcea71f74dffe1da4ab3e3d0ce548f2f79f649ca88ecb603477bbb7ce',
          tier: 'plan',
          effect: 'read',
        },
      },
    });
    expect(INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE).toBe(
      'https://github.com/aantenore/semwitness/blob/v0.5.0-alpha.5/docs/attestations/cache-admission-decision/v0.1.md',
    );
    expect(INTENT_CACHE_ADMISSION_DECISION_DSSE_PAYLOAD_TYPE).toBe(
      'application/vnd.in-toto+json',
    );
    expect(statement.subject).toEqual([
      {
        name: INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME,
        digest: {
          sha256: GOLDEN_PASSPORT_PAYLOAD_DIGEST.slice('sha256:'.length),
        },
      },
      {
        name: INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME,
        digest: {
          sha256: GOLDEN_WITNESS_PAYLOAD_DIGEST.slice('sha256:'.length),
        },
      },
    ]);
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(3_013);
    expect(serialized.endsWith('\n')).toBe(false);
    expect(digestIntentCacheAdmissionDecisionCanonicalProfile(statement)).toBe(
      GOLDEN_DECISION_DIGEST,
    );
    expect(parseIntentCacheAdmissionDecisionStatement(serialized)).toEqual(
      statement,
    );
    expect(
      serializeIntentCacheAdmissionDecisionStatement(
        createIntentCacheAdmissionDecisionStatement(evidence),
      ),
    ).toBe(serialized);
  });

  it('binds only exact canonical Statement bytes while reporting profile equality separately', () => {
    expect(
      verifyIntentCacheAdmissionDecisionStatementBinding(serialized, evidence),
    ).toEqual({
      bound: true,
      profileBound: true,
      extensionsPresent: false,
      canonicalProfileDigest: GOLDEN_DECISION_DIGEST,
      payloadDigest: GOLDEN_DECISION_DIGEST,
      canonicalPayload: true,
      statementPassportPayloadDigest: GOLDEN_PASSPORT_PAYLOAD_DIGEST,
      suppliedPassportPayloadDigest: GOLDEN_PASSPORT_PAYLOAD_DIGEST,
      statementWitnessPayloadDigest: GOLDEN_WITNESS_PAYLOAD_DIGEST,
      suppliedWitnessPayloadDigest: GOLDEN_WITNESS_PAYLOAD_DIGEST,
      servingAuthority: 'none',
    });

    expect(
      verifyIntentCacheAdmissionDecisionStatementBinding(statement, evidence),
    ).toMatchObject({
      bound: false,
      profileBound: true,
      extensionsPresent: false,
      payloadDigest: null,
      canonicalPayload: null,
      servingAuthority: 'none',
    });

    const withLineFeed = `${serialized}\n`;
    expect(parseIntentCacheAdmissionDecisionStatement(withLineFeed)).toEqual(
      statement,
    );
    expect(
      verifyIntentCacheAdmissionDecisionStatementBinding(
        withLineFeed,
        evidence,
      ),
    ).toMatchObject({
      bound: false,
      profileBound: true,
      extensionsPresent: false,
      canonicalProfileDigest: GOLDEN_DECISION_DIGEST,
      payloadDigest: sha256(withLineFeed),
      canonicalPayload: false,
    });

    const extended = mutableStatement();
    extended.subject[0].content = { rawPrompt: 'must-never-bind' };
    extended.predicate.future = { rawValue: 'must-never-bind' };
    const extendedBytes = JSON.stringify(extended);
    expect(parseIntentCacheAdmissionDecisionStatement(extendedBytes)).toEqual(
      statement,
    );
    expect(
      verifyIntentCacheAdmissionDecisionStatementBinding(
        extendedBytes,
        evidence,
      ),
    ).toMatchObject({
      bound: false,
      profileBound: false,
      extensionsPresent: true,
      canonicalProfileDigest: GOLDEN_DECISION_DIGEST,
      canonicalPayload: false,
    });
  });

  it('rejects noncanonical evidence, tampering, and valid-but-mismatched cross-links', () => {
    const differentQualification = mutable(evidence.qualification);
    differentQualification.deploymentScopeDigest = sha256(
      'different-deployment-scope',
    );

    const tamperedWitness = JSON.parse(
      evidence.cacheHitWitness as string,
    ) as Record<string, any>;
    tamperedWitness.entry.valueDigest = sha256('substituted-value');

    const mismatchedNormalization = mutable(evidence.normalizationWitness);
    mismatchedNormalization.witnessDigest = sha256(
      'different-normalization-witness',
    );

    const invalidEvidence: readonly [
      string,
      IntentCacheAdmissionDecisionEvidence,
    ][] = [
      [
        'noncanonical Passport bytes',
        withEvidence({ passport: `${evidence.passport as string}\n` }),
      ],
      [
        'noncanonical cache-hit witness bytes',
        withEvidence({
          cacheHitWitness: `${evidence.cacheHitWitness as string}\n`,
        }),
      ],
      [
        'different qualification',
        withEvidence({ qualification: differentQualification }),
      ],
      [
        'tampered cache-hit witness',
        withEvidence({ cacheHitWitness: JSON.stringify(tamperedWitness) }),
      ],
      [
        'mismatched normalization witness',
        withEvidence({ normalizationWitness: mismatchedNormalization }),
      ],
      [
        'mismatched operation binding',
        withEvidence({ operationBinding: mismatchedOperationBinding() }),
      ],
      [
        'mismatched entry-source binding',
        withEvidence({ entrySourceBinding: mismatchedEntrySourceBinding() }),
      ],
      [
        'substituted candidate value',
        withEvidence({ value: 'candidate-artifact:false' }),
      ],
    ];

    for (const [label, candidate] of invalidEvidence) {
      expect(
        () => createIntentCacheAdmissionDecisionStatement(candidate),
        label,
      ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    }
  });

  it('rejects valid re-digested qualification mismatches at every shared cross-link', () => {
    const crossLinkMutations: readonly [
      string,
      (qualification: Record<string, any>) => void,
    ][] = [
      [
        'cache namespace',
        (qualification) => {
          qualification.scope.cacheNamespace = `hmac-sha256:cache-namespace:${'8'.repeat(64)}`;
        },
      ],
      [
        'tenant',
        (qualification) => {
          qualification.scope.tenant = `hmac-sha256:tenant:${'8'.repeat(64)}`;
        },
      ],
      [
        'cache-admission policy',
        (qualification) => {
          qualification.intentContract.cacheAdmissionPolicyDigest = sha256(
            'other-cache-admission-policy',
          );
        },
      ],
      [
        'normalization policy',
        (qualification) => {
          qualification.intentContract.normalizationPolicyDigest = sha256(
            'other-normalization-policy',
          );
        },
      ],
      [
        'normalizer',
        (qualification) => {
          qualification.intentContract.normalizer.artifactDigest = sha256(
            'other-normalizer-artifact',
          );
        },
      ],
      [
        'ontology',
        (qualification) => {
          qualification.intentContract.ontology.digest =
            sha256('other-ontology');
        },
      ],
      [
        'operation registry',
        (qualification) => {
          qualification.intentContract.operationRegistry.digest = sha256(
            'other-operation-registry',
          );
        },
      ],
      [
        'planner',
        (qualification) => {
          qualification.dependencies.planner.artifact.digest =
            sha256('other-planner');
        },
      ],
      [
        'tool registry',
        (qualification) => {
          qualification.dependencies.tool.artifact.digest = sha256(
            'other-tool-registry',
          );
        },
      ],
    ];
    for (const [label, mutate] of crossLinkMutations) {
      expect(
        () =>
          createIntentCacheAdmissionDecisionStatement(
            withChangedQualification(mutate),
          ),
        label,
      ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    }
  });

  it('labels Passport-only scope and inventory declarations without claiming per-hit proof', () => {
    const deploymentScopeDigest = sha256('other-deployment-scope');
    const providerDigest = sha256('other-provider-runtime');
    const changedScope = createIntentCacheAdmissionDecisionStatement(
      withChangedQualification((qualification) => {
        qualification.deploymentScopeDigest = deploymentScopeDigest;
      }),
    );
    const changedProvider = createIntentCacheAdmissionDecisionStatement(
      withChangedQualification((qualification) => {
        qualification.dependencies.provider.artifact.digest = providerDigest;
      }),
    );

    expect(
      changedScope.predicate.scope.qualificationDeploymentScopeDigest,
    ).toBe(deploymentScopeDigest);
    expect(changedScope.subject[1]).toEqual(statement.subject[1]);
    expect(changedProvider.predicate.contracts).not.toEqual(
      statement.predicate.contracts,
    );
    expect(changedProvider.subject[1]).toEqual(statement.subject[1]);
    expect('deploymentScopeDigest' in changedScope.predicate.scope).toBe(false);
    expect('dependenciesDigest' in changedProvider.predicate.contracts).toBe(
      false,
    );
  });

  it('proves cache-artifact HMAC domain separation and input binding', () => {
    const hit = parseCacheHitWitnessArtifact(evidence.cacheHitWitness);
    const binding = hit.lookup.binding;
    const sameDigest = sha256('same-entry-and-value');
    const baseline = hmacCacheArtifactCommitments(
      CACHE_KEY_SECRET,
      binding,
      sameDigest,
      sameDigest,
    );
    expect(baseline.entry.slice('hmac-sha256:cache-entry:'.length)).not.toBe(
      baseline.value.slice('hmac-sha256:cache-value:'.length),
    );

    const changedSecret = hmacCacheArtifactCommitments(
      'fedcba9876543210fedcba9876543210',
      binding,
      sameDigest,
      sameDigest,
    );
    const changedBinding = hmacCacheArtifactCommitments(
      CACHE_KEY_SECRET,
      {
        ...binding,
        contextDigest: `hmac-sha256:context:${'8'.repeat(64)}`,
      },
      sameDigest,
      sameDigest,
    );
    const changedDigest = hmacCacheArtifactCommitments(
      CACHE_KEY_SECRET,
      binding,
      sha256('other-entry'),
      sha256('other-value'),
    );
    expect(changedSecret).not.toEqual(baseline);
    expect(changedBinding).not.toEqual(baseline);
    expect(changedDigest).not.toEqual(baseline);
    expect(() =>
      hmacCacheArtifactCommitments(
        'weak-secret',
        binding,
        sameDigest,
        sameDigest,
      ),
    ).toThrow(/at least 32 bytes/u);
  });

  it('distinguishes well-formed profile tampering from invalid escalation attempts', () => {
    const profileMutations: readonly ((value: Record<string, any>) => void)[] =
      [
        (value) => {
          value.subject[0].digest.sha256 = '0'.repeat(64);
        },
        (value) => {
          value.predicate.lineage.operationBindingDigest = sha256(
            'other-operation-binding',
          );
        },
        (value) => {
          value.predicate.scope.principal = `hmac-sha256:principal:${'0'.repeat(64)}`;
        },
        (value) => {
          value.predicate.candidate.entryCommitment = `hmac-sha256:cache-entry:${'0'.repeat(64)}`;
        },
        (value) => {
          value.predicate.contracts.qualificationDependenciesDigest =
            sha256('other-dependencies');
        },
        (value) => {
          value.predicate.privacy.sourceDigest = `hmac-sha256:intent-source:${'0'.repeat(64)}`;
        },
      ];
    for (const mutate of profileMutations) {
      const changed = mutableStatement();
      mutate(changed);
      const changedBytes =
        serializeIntentCacheAdmissionDecisionStatement(changed);
      expect(
        verifyIntentCacheAdmissionDecisionStatementBinding(
          changedBytes,
          evidence,
        ),
      ).toMatchObject({
        bound: false,
        profileBound: false,
        extensionsPresent: false,
        canonicalPayload: true,
      });
    }

    const invariantMutations: readonly ((
      value: Record<string, any>,
    ) => void)[] = [
      (value) => {
        value.predicate.authentication = 'signature';
      },
      (value) => {
        value.predicate.mode = 'active';
      },
      (value) => {
        value.predicate.activationCeiling = 'live';
      },
      (value) => {
        value.predicate.decision.applied = true;
      },
      (value) => {
        value.predicate.servingAuthority = 'cache-read';
      },
      (value) => {
        value.predicate.candidate.tier = 'response';
      },
      (value) => {
        value.predicate.privacy.valueContentIncluded = true;
      },
    ];
    for (const mutate of invariantMutations) {
      const changed = mutableStatement();
      mutate(changed);
      expect(() => parseIntentCacheAdmissionDecisionStatement(changed)).toThrow(
        /Malformed intent-cache Admission Decision Statement/u,
      );
    }
  });

  it('snapshots the complete evidence record without invoking untrusted code', () => {
    let proxyTrapCalls = 0;
    const proxiedEvidence = new Proxy(
      { ...evidence },
      {
        ownKeys(target) {
          proxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() =>
      createIntentCacheAdmissionDecisionStatement(proxiedEvidence),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    expect(proxyTrapCalls).toBe(0);

    let secretGetterCalls = 0;
    const accessorEvidence = { ...evidence };
    Object.defineProperty(accessorEvidence, 'cacheKeySecret', {
      enumerable: true,
      get() {
        secretGetterCalls += 1;
        return secretGetterCalls % 2 === 1
          ? CACHE_KEY_SECRET
          : 'fedcba9876543210fedcba9876543210';
      },
    });
    expect(() =>
      createIntentCacheAdmissionDecisionStatement(
        accessorEvidence as IntentCacheAdmissionDecisionEvidence,
      ),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    expect(secretGetterCalls).toBe(0);

    const extraEvidence = { ...evidence, unexpected: true };
    const missingEvidence = { ...evidence } as Record<string, unknown>;
    delete missingEvidence.value;
    const hiddenEvidence = { ...evidence };
    Object.defineProperty(hiddenEvidence, 'value', {
      configurable: true,
      enumerable: false,
      value: CANDIDATE_VALUE,
      writable: true,
    });
    const inheritedEvidence = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      evidence,
    );
    for (const candidate of [
      extraEvidence,
      missingEvidence,
      hiddenEvidence,
      inheritedEvidence,
    ]) {
      expect(() =>
        createIntentCacheAdmissionDecisionStatement(
          candidate as unknown as IntentCacheAdmissionDecisionEvidence,
        ),
      ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    }
  });

  it('copies byte evidence and exact Statement bytes through intrinsic state only', () => {
    const secretBytes = new TextEncoder().encode(CACHE_KEY_SECRET);
    const passportBytes = new TextEncoder().encode(evidence.passport as string);
    const witnessBytes = new TextEncoder().encode(
      evidence.cacheHitWitness as string,
    );
    const valueBytes = new TextEncoder().encode(CANDIDATE_VALUE);
    const statementBytes = new TextEncoder().encode(serialized);
    let shadowedBufferGetterCalls = 0;
    for (const bytes of [
      secretBytes,
      passportBytes,
      witnessBytes,
      valueBytes,
      statementBytes,
    ]) {
      Object.defineProperty(bytes, 'buffer', {
        configurable: true,
        get() {
          shadowedBufferGetterCalls += 1;
          throw new TypeError('must never be invoked');
        },
      });
    }

    const byteEvidence = withEvidence({
      passport: passportBytes,
      cacheHitWitness: witnessBytes,
      cacheKeySecret: secretBytes,
      value: valueBytes,
    });
    expect(
      serializeIntentCacheAdmissionDecisionStatement(
        createIntentCacheAdmissionDecisionStatement(byteEvidence),
      ),
    ).toBe(serialized);
    expect(
      verifyIntentCacheAdmissionDecisionStatementBinding(
        statementBytes,
        byteEvidence,
      ),
    ).toMatchObject({
      bound: true,
      profileBound: true,
      canonicalPayload: true,
      statementPassportPayloadDigest: GOLDEN_PASSPORT_PAYLOAD_DIGEST,
      suppliedPassportPayloadDigest: GOLDEN_PASSPORT_PAYLOAD_DIGEST,
      statementWitnessPayloadDigest: GOLDEN_WITNESS_PAYLOAD_DIGEST,
      suppliedWitnessPayloadDigest: GOLDEN_WITNESS_PAYLOAD_DIGEST,
    });
    expect(shadowedBufferGetterCalls).toBe(0);
  });

  it('rejects SharedArrayBuffer-backed evidence instead of accepting a racy snapshot', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const sharedSecret = new Uint8Array(
      new SharedArrayBuffer(Buffer.byteLength(CACHE_KEY_SECRET, 'utf8')),
    );
    sharedSecret.set(new TextEncoder().encode(CACHE_KEY_SECRET));
    expect(() =>
      createIntentCacheAdmissionDecisionStatement(
        withEvidence({ cacheKeySecret: sharedSecret }),
      ),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
  });

  it('enforces every byte limit before accepting exact payload inputs', () => {
    const oversizedEvidence: readonly IntentCacheAdmissionDecisionEvidence[] = [
      withEvidence({
        passport: 'p'.repeat(MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES + 1),
      }),
      withEvidence({
        cacheHitWitness: new Uint8Array(
          MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES + 1,
        ),
      }),
      withEvidence({
        cacheKeySecret: 's'.repeat(MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES + 1),
      }),
      withEvidence({
        value: new Uint8Array(MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES + 1),
      }),
    ];
    for (const candidate of oversizedEvidence) {
      expect(() =>
        createIntentCacheAdmissionDecisionStatement(candidate),
      ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    }
    expect(() =>
      verifyIntentCacheAdmissionDecisionStatementBinding(
        new Uint8Array(MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES + 1),
        evidence,
      ),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
  });

  it('stays content-free and rejects ambiguous or unsafe parser inputs', () => {
    for (const secret of [CACHE_KEY_SECRET, CANDIDATE_VALUE, 'safe-lookup']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(
      /"(?:prompt|response|normalizedIntent|intentIr|entryDigest|valueDigest|path|url)"\s*:/iu,
    );
    expect(serialized).toContain('"servingAuthority":"none"');
    expect(serialized).toContain('"sourceContentIncluded":false');
    expect(serialized).toContain('"valueContentIncluded":false');
    expect(serialized).toContain('"rawIdentifiersIncluded":false');

    const duplicateType = serialized.replace(
      '{"_type":',
      '{"_type":"https://in-toto.io/Statement/v1","_type":',
    );
    expect(() =>
      parseIntentCacheAdmissionDecisionStatement(duplicateType),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    expect(() =>
      parseIntentCacheAdmissionDecisionStatement(new Uint8Array([0xff])),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);
    expect(() =>
      parseIntentCacheAdmissionDecisionStatement(
        ' '.repeat(MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES + 1),
      ),
    ).toThrow(/Malformed intent-cache Admission Decision Statement/u);

    let proxyTrapCalls = 0;
    const proxied = new Proxy(mutableStatement(), {
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => parseIntentCacheAdmissionDecisionStatement(proxied)).toThrow(
      /Malformed intent-cache Admission Decision Statement/u,
    );
    expect(proxyTrapCalls).toBe(0);

    let getterCalls = 0;
    const accessor = mutableStatement();
    Object.defineProperty(accessor, 'future', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'never';
      },
    });
    expect(() => parseIntentCacheAdmissionDecisionStatement(accessor)).toThrow(
      /Malformed intent-cache Admission Decision Statement/u,
    );
    expect(getterCalls).toBe(0);
  });
});
