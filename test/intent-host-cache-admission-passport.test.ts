import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  IN_TOTO_STATEMENT_V1_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
  INTENT_CACHE_ADMISSION_PASSPORT_DSSE_PAYLOAD_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
  createIntentCacheAdmissionPassportStatement,
  digestIntentCacheAdmissionPassportCanonicalProfile,
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheAdmissionPassportStatement,
  parseIntentCacheShadowQualificationManifest,
  serializeIntentCacheAdmissionPassportStatement,
  serializeIntentCacheShadowQualificationManifest,
  verifyIntentCacheAdmissionPassportStatementBinding,
  type IntentCacheAdmissionPassportStatement,
  type IntentCacheShadowQualificationManifest,
} from '../src/intent-host/index.js';

interface StatementMutation {
  readonly label: string;
  readonly mutate: (value: Record<string, any>) => void;
}

let qualification: IntentCacheShadowQualificationManifest;
let statement: IntentCacheAdmissionPassportStatement;
let serialized: string;

function mutableStatement(): Record<string, any> {
  return JSON.parse(serialized) as Record<string, any>;
}

function mutableQualification(): Record<string, any> {
  return JSON.parse(JSON.stringify(qualification)) as Record<string, any>;
}

beforeAll(async () => {
  const qualificationSource = await readFile(
    new URL(
      './fixtures/intent-cache-shadow-qualification.json',
      import.meta.url,
    ),
    'utf8',
  );
  qualification = parseIntentCacheShadowQualificationManifest(
    JSON.parse(qualificationSource),
  );
  statement = createIntentCacheAdmissionPassportStatement(qualification);
  serialized = serializeIntentCacheAdmissionPassportStatement(statement);
});

const derivedBindingMutations: readonly StatementMutation[] = [
  {
    label: 'subject qualification digest',
    mutate: (value) => {
      value.subject[0].digest.sha256 = '0'.repeat(64);
    },
  },
  {
    label: 'validity notBefore',
    mutate: (value) => {
      value.predicate.validity.notBefore = '1970-01-01T00:00:01.500Z';
    },
  },
  {
    label: 'validity notAfter',
    mutate: (value) => {
      value.predicate.validity.notAfter = '1970-01-01T00:00:02.500Z';
    },
  },
  {
    label: 'validity revocationId',
    mutate: (value) => {
      value.predicate.validity.revocationId = `hmac-sha256:revocation:${'5'.repeat(64)}`;
    },
  },
  {
    label: 'scope deploymentScopeDigest',
    mutate: (value) => {
      value.predicate.scope.deploymentScopeDigest = sha256('other-deployment');
    },
  },
  {
    label: 'scope cacheNamespace',
    mutate: (value) => {
      value.predicate.scope.cacheNamespace = `hmac-sha256:cache-namespace:${'5'.repeat(64)}`;
    },
  },
  {
    label: 'scope tenant',
    mutate: (value) => {
      value.predicate.scope.tenant = `hmac-sha256:tenant:${'5'.repeat(64)}`;
    },
  },
  {
    label: 'scope domain',
    mutate: (value) => {
      value.predicate.scope.domain = `hmac-sha256:intent-domain:${'5'.repeat(64)}`;
    },
  },
  {
    label: 'scope operation',
    mutate: (value) => {
      value.predicate.scope.operation = `hmac-sha256:operation:${'5'.repeat(64)}`;
    },
  },
  {
    label: 'cache admission contract',
    mutate: (value) => {
      value.predicate.contracts.cacheAdmissionPolicyDigest = sha256(
        'other-cache-admission-policy',
      );
    },
  },
  {
    label: 'normalization contract',
    mutate: (value) => {
      value.predicate.contracts.normalizationPolicyDigest = sha256(
        'other-normalization-policy',
      );
    },
  },
  {
    label: 'dependencies contract',
    mutate: (value) => {
      value.predicate.contracts.dependenciesDigest =
        sha256('other-dependencies');
    },
  },
  {
    label: 'evidence report digest',
    mutate: (value) => {
      value.predicate.evidence.reportDigest = sha256('other-report');
    },
  },
  {
    label: 'evidence evaluator digest',
    mutate: (value) => {
      value.predicate.evidence.evaluatorDigest = sha256('other-evaluator');
    },
  },
];

const invariantMutations: readonly StatementMutation[] = [
  {
    label: 'Passport artifact id',
    mutate: (value) => {
      value.predicate.artifact.id = 'other-passport';
    },
  },
  {
    label: 'Passport artifact version',
    mutate: (value) => {
      value.predicate.artifact.version = '0.2.0';
    },
  },
  {
    label: 'profile',
    mutate: (value) => {
      value.predicate.profile = 'response-read';
    },
  },
  {
    label: 'authentication',
    mutate: (value) => {
      value.predicate.authentication = 'external-signature';
    },
  },
  {
    label: 'decision',
    mutate: (value) => {
      value.predicate.decision = 'approved';
    },
  },
  {
    label: 'activation ceiling',
    mutate: (value) => {
      value.predicate.activationCeiling = 'live';
    },
  },
  {
    label: 'basis schema',
    mutate: (value) => {
      value.predicate.basis.schema = 'example.invalid/qualification/v1';
    },
  },
  {
    label: 'basis artifact id',
    mutate: (value) => {
      value.predicate.basis.artifact.id = 'other-qualifier';
    },
  },
  {
    label: 'basis artifact version',
    mutate: (value) => {
      value.predicate.basis.artifact.version = '2';
    },
  },
  {
    label: 'basis provenance',
    mutate: (value) => {
      value.predicate.basis.provenance = 'authenticated';
    },
  },
  {
    label: 'basis evidence authentication',
    mutate: (value) => {
      value.predicate.basis.evidenceAuthentication = 'signature';
    },
  },
  {
    label: 'basis producer identity',
    mutate: (value) => {
      value.predicate.basis.producerIdentity = 'issuer';
    },
  },
];

describe('intent-cache admission Passport Statement', () => {
  it('emits deterministic in-toto bytes and a golden binding', () => {
    expect(statement).toMatchObject({
      _type: IN_TOTO_STATEMENT_V1_TYPE,
      predicateType: INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
      predicate: {
        artifact: INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
        profile: 'intent-plan-read',
        authentication: 'none',
        decision: 'shadow-qualified',
        activationCeiling: 'shadow-only',
        validity: {
          notBefore: '1970-01-01T00:00:01.000Z',
          notAfter: '1970-01-01T00:00:02.000Z',
        },
      },
    });
    expect(INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE).toBe(
      'https://github.com/aantenore/semwitness/blob/main/docs/attestations/cache-admission-passport/v0.1.md',
    );
    expect(INTENT_CACHE_ADMISSION_PASSPORT_DSSE_PAYLOAD_TYPE).toBe(
      'application/vnd.in-toto+json',
    );
    expect(statement.subject).toHaveLength(1);
    expect(`sha256:${statement.subject[0].digest.sha256}`).toBe(
      'sha256:529de6ccf1fc1de323bc9e136ea740ee1342f56f3d8ca848a13f91f2a89f5332',
    );
    expect(digestIntentCacheAdmissionPassportCanonicalProfile(statement)).toBe(
      'sha256:323b9a45fccd2b3e42c06d448c24c7adf1e340ca3f7ce0753882aba4bf611287',
    );
    expect(serialized).toBe(
      serializeIntentCacheAdmissionPassportStatement(
        createIntentCacheAdmissionPassportStatement(qualification),
      ),
    );
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
    );
  });

  it('defines the qualification subject as the exact canonical artifact bytes', () => {
    const exactQualificationBytes =
      serializeIntentCacheShadowQualificationManifest(qualification);
    expect(digestIntentCacheShadowQualificationManifest(qualification)).toBe(
      sha256(exactQualificationBytes),
    );
    expect(`sha256:${statement.subject[0].digest.sha256}`).toBe(
      sha256(exactQualificationBytes),
    );
    expect(exactQualificationBytes.endsWith('\n')).toBe(false);
  });

  it('round-trips strict JSON bytes into isolated deeply frozen state', () => {
    const parsedText = parseIntentCacheAdmissionPassportStatement(serialized);
    const parsedBytes = parseIntentCacheAdmissionPassportStatement(
      new TextEncoder().encode(serialized),
    );
    expect(parsedText).toEqual(statement);
    expect(parsedBytes).toEqual(statement);
    expect(Object.isFrozen(parsedText)).toBe(true);
    expect(Object.isFrozen(parsedText.subject)).toBe(true);
    expect(Object.isFrozen(parsedText.subject[0].digest)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate.basis.artifact)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate.validity)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate.scope)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate.contracts)).toBe(true);
    expect(Object.isFrozen(parsedText.predicate.evidence)).toBe(true);

    const source = mutableQualification();
    const isolated = createIntentCacheAdmissionPassportStatement(source);
    source.validity.notAfterEpochMs = 9_999;
    expect(isolated.predicate.validity.notAfter).toBe(
      '1970-01-01T00:00:02.000Z',
    );
  });

  it('reports exact payload identity separately from canonical profile identity', () => {
    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        serialized,
        qualification,
      ),
    ).toEqual({
      bound: true,
      extensionsPresent: false,
      canonicalProfileDigest: sha256(serialized),
      payloadDigest: sha256(serialized),
      canonicalPayload: true,
      statementQualificationDigest:
        'sha256:529de6ccf1fc1de323bc9e136ea740ee1342f56f3d8ca848a13f91f2a89f5332',
      suppliedQualificationDigest:
        'sha256:529de6ccf1fc1de323bc9e136ea740ee1342f56f3d8ca848a13f91f2a89f5332',
    });

    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        statement,
        qualification,
      ),
    ).toMatchObject({
      bound: true,
      extensionsPresent: false,
      payloadDigest: null,
      canonicalPayload: null,
    });

    const nonCanonicalPayload = `${serialized}\n`;
    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        nonCanonicalPayload,
        qualification,
      ),
    ).toMatchObject({
      bound: false,
      extensionsPresent: false,
      canonicalProfileDigest: sha256(serialized),
      payloadDigest: sha256(nonCanonicalPayload),
      canonicalPayload: false,
    });

    const differentQualification = mutableQualification();
    differentQualification.deploymentScopeDigest = sha256(
      'different-deployment-scope',
    );
    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        statement,
        differentQualification,
      ).bound,
    ).toBe(false);
  });

  it.each(derivedBindingMutations)(
    'fails binding for a well-formed mutation of $label',
    ({ mutate }) => {
      const changed = mutableStatement();
      mutate(changed);
      expect(parseIntentCacheAdmissionPassportStatement(changed)).toBeDefined();
      expect(
        verifyIntentCacheAdmissionPassportStatementBinding(
          changed,
          qualification,
        ).bound,
      ).toBe(false);
    },
  );

  it.each(invariantMutations)(
    'rejects a wire-invariant mutation of $label',
    ({ mutate }) => {
      const changed = mutableStatement();
      mutate(changed);
      expect(() => parseIntentCacheAdmissionPassportStatement(changed)).toThrow(
        /Malformed intent-cache admission Passport Statement/u,
      );
    },
  );

  it('parses bounded extensions monotonically but rejects them for content-free binding', () => {
    const extended = mutableStatement();
    extended.futureStatementField = { ignored: true };
    extended.subject[0].content = { raw: 'must-not-enter-profile' };
    extended.subject[0].digest.sha512 = 'ignored';
    extended.predicate.rawPrompt = 'must-not-enter-profile';
    extended.predicate.scope.futureScopeField = 'ignored';
    const extendedBytes = JSON.stringify(extended);

    expect(parseIntentCacheAdmissionPassportStatement(extendedBytes)).toEqual(
      statement,
    );
    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        extendedBytes,
        qualification,
      ),
    ).toMatchObject({
      bound: false,
      extensionsPresent: true,
      canonicalProfileDigest:
        digestIntentCacheAdmissionPassportCanonicalProfile(statement),
      payloadDigest: sha256(extendedBytes),
      canonicalPayload: false,
    });
  });

  it('rejects unbounded or non-data-only extension values without invoking them', () => {
    const oversizedKey = mutableStatement();
    oversizedKey['x'.repeat(1_025)] = true;
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(oversizedKey),
    ).toThrow(/Malformed intent-cache admission Passport Statement/u);

    const oversized = mutableStatement();
    oversized.future = 'x'.repeat(1_025);
    expect(() => parseIntentCacheAdmissionPassportStatement(oversized)).toThrow(
      /Malformed intent-cache admission Passport Statement/u,
    );

    const cyclic = mutableStatement();
    cyclic.future = {};
    cyclic.future.self = cyclic.future;
    expect(() => parseIntentCacheAdmissionPassportStatement(cyclic)).toThrow(
      /Malformed intent-cache admission Passport Statement/u,
    );

    let nestedGetterCalls = 0;
    const accessor = mutableStatement();
    accessor.future = {};
    Object.defineProperty(accessor.future, 'nested', {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return 'never';
      },
    });
    expect(() => parseIntentCacheAdmissionPassportStatement(accessor)).toThrow(
      /Malformed intent-cache admission Passport Statement/u,
    );
    expect(nestedGetterCalls).toBe(0);

    let nestedProxyTrapCalls = 0;
    const proxied = mutableStatement();
    proxied.future = new Proxy(
      {},
      {
        ownKeys(target) {
          nestedProxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() => parseIntentCacheAdmissionPassportStatement(proxied)).toThrow(
      /Malformed intent-cache admission Passport Statement/u,
    );
    expect(nestedProxyTrapCalls).toBe(0);
  });

  it('rejects type confusion, invalid time, extra subjects, and raw facts', () => {
    for (const mutate of [
      (value: Record<string, any>) => {
        value._type = 'https://in-toto.io/Statement/v0.1';
      },
      (value: Record<string, any>) => {
        value.predicateType = 'https://example.invalid/passport/v0.1';
      },
      (value: Record<string, any>) => {
        value.predicate.validity.notBefore = '1970-01-01T00:00:01Z';
      },
      (value: Record<string, any>) => {
        value.predicate.validity.notAfter = '1970-01-01T00:00:00.999Z';
      },
      (value: Record<string, any>) => {
        value.predicate.validity.notAfter = '2024-02-30T00:00:00.000Z';
      },
      (value: Record<string, any>) => {
        value.subject.push(value.subject[0]);
      },
    ]) {
      const value = mutableStatement();
      mutate(value);
      expect(() => parseIntentCacheAdmissionPassportStatement(value)).toThrow(
        /Malformed intent-cache admission Passport Statement/u,
      );
    }

    expect(serialized).not.toContain('safe-lookup');
    expect(serialized).not.toContain('unsafe-lookup');
    expect(serialized).not.toContain('distributed-inference');
    expect(serialized).not.toContain('tenant-a');
    expect(serialized).not.toContain('0123456789abcdef0123456789abcdef');
    expect(serialized).not.toMatch(
      /"(?:promptText|response|normalizedText|payload|url|path)"/u,
    );
    expect(serialized).not.toMatch(
      /"(?:active|canary|approved|authorization)"/u,
    );
  });

  it('rejects duplicate keys, invalid UTF-8, and oversized bytes', () => {
    const duplicateType = serialized.replace(
      '{"_type":',
      `{"_type":"${IN_TOTO_STATEMENT_V1_TYPE}","_type":`,
    );
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(duplicateType),
    ).toThrow(/Malformed intent-cache admission Passport Statement/u);
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(new Uint8Array([0xff])),
    ).toThrow(/Malformed intent-cache admission Passport Statement/u);
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(
        ' '.repeat(MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES + 1),
      ),
    ).toThrow(/Malformed intent-cache admission Passport Statement/u);
  });

  it('rejects proxies, accessors, symbols, hidden fields, and prototypes safely', () => {
    let proxyTrapCalls = 0;
    const proxied = new Proxy(mutableStatement(), {
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => parseIntentCacheAdmissionPassportStatement(proxied)).toThrow();
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
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(accessor),
    ).toThrow();
    expect(getterCalls).toBe(0);

    const symbolic = mutableStatement();
    Object.defineProperty(symbolic, Symbol('hidden'), {
      enumerable: true,
      value: true,
    });
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(symbolic),
    ).toThrow();

    const hidden = mutableStatement();
    Object.defineProperty(hidden, 'hidden', {
      enumerable: false,
      value: true,
    });
    expect(() => parseIntentCacheAdmissionPassportStatement(hidden)).toThrow();

    const inherited = mutableStatement();
    Object.setPrototypeOf(inherited, { inherited: true });
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(inherited),
    ).toThrow();

    const arrayProxy = mutableStatement();
    arrayProxy.subject = new Proxy(arrayProxy.subject, {});
    expect(() =>
      parseIntentCacheAdmissionPassportStatement(arrayProxy),
    ).toThrow();
  });
});
