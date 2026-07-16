import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
  INTENT_CACHE_OPERATION_BINDING_SCHEMA,
  INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
  parseIntentCacheLookupReceipt,
  parseIntentCacheOperationBinding,
  parseIntentNormalizationBypassReceipt,
  recomputeIntentCacheLookupReceiptDigest,
  recomputeIntentCacheOperationBindingDigest,
  recomputeIntentNormalizationBypassReceiptDigest,
  type IntentCacheAccountingBinding,
  type IntentCacheDependencyBinding,
  type IntentCacheDomainHmac,
  type IntentCacheLookupDisposition,
  type IntentCacheLookupReceipt,
  type IntentCacheOperationBinding,
  type IntentCacheOperationHmac,
  type IntentNormalizationBypassReason,
  type IntentNormalizationBypassReceipt,
} from '../src/intent-host/index.js';
import type {
  CacheKeyDigest,
  HmacIntentSourceDigest,
  IntentEffect,
  NormalizerBinding,
  OntologyBinding,
} from '../src/intent/types.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const OPERATION =
  `hmac-sha256:operation:${'1'.repeat(64)}` as IntentCacheOperationHmac;
const DOMAIN =
  `hmac-sha256:intent-domain:${'2'.repeat(64)}` as IntentCacheDomainHmac;
const SOURCE =
  `hmac-sha256:intent-source:${'3'.repeat(64)}` as HmacIntentSourceDigest;
const CACHE_KEY = `hmac-sha256:cache-key:${'4'.repeat(64)}` as CacheKeyDigest;
const NORMALIZER: NormalizerBinding = {
  id: 'test-normalizer',
  version: '1',
  artifactDigest: sha256('normalizer-artifact'),
  configDigest: sha256('normalizer-config'),
};
const ONTOLOGY: OntologyBinding = {
  id: 'test-ontology',
  version: '1',
  digest: sha256('ontology'),
};

function dependency(
  id: string,
  status: IntentCacheDependencyBinding['status'] = 'enabled',
): IntentCacheDependencyBinding {
  return {
    status,
    artifact: { id, version: '1', digest: sha256(`${id}:1`) },
  };
}

function accounting(
  completeness: IntentCacheAccountingBinding['completeness'] = 'complete',
): IntentCacheAccountingBinding {
  return completeness === 'complete'
    ? { completeness }
    : {
        completeness,
        failureDigest: sha256('accounting-incomplete'),
      };
}

function operationBinding(
  effect: IntentEffect = 'read',
): IntentCacheOperationBinding {
  const candidate: Record<string, unknown> = {
    schema: INTENT_CACHE_OPERATION_BINDING_SCHEMA,
    operation: OPERATION,
    domain: DOMAIN,
    intentDigest: sha256('intent'),
    tier: 'plan',
    effect,
    operationRegistryDigest: sha256('operation-registry'),
    ontologyDigest: ONTOLOGY.digest,
    bindingDigest: sha256('placeholder'),
  };
  candidate.bindingDigest =
    recomputeIntentCacheOperationBindingDigest(candidate);
  return parseIntentCacheOperationBinding(candidate);
}

function lookupReceipt(options?: {
  readonly effect?: IntentEffect;
  readonly disposition?: IntentCacheLookupDisposition;
  readonly accountingCompleteness?: IntentCacheAccountingBinding['completeness'];
}): IntentCacheLookupReceipt {
  const candidate: Record<string, unknown> = {
    schema: INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
    mode: 'shadow',
    applied: false,
    sourceDigest: SOURCE,
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    normalizationPolicyDigest: sha256('normalization-policy'),
    cacheAdmissionPolicyDigest: sha256('cache-admission-policy'),
    cacheKeyDigest: CACHE_KEY,
    observedOperationBinding: operationBinding(options?.effect),
    candidateIndex: dependency('candidate-index'),
    store: dependency('store'),
    ...(options?.disposition ?? {
      outcome: 'miss',
      reason: 'NO_CANDIDATE_FOUND',
      storeAccess: 'attempted',
    }),
    accounting: accounting(options?.accountingCompleteness),
    receiptDigest: sha256('placeholder'),
  };
  candidate.receiptDigest = recomputeIntentCacheLookupReceiptDigest(candidate);
  return parseIntentCacheLookupReceipt(candidate);
}

function normalizationBypassReceipt(
  reason: IntentNormalizationBypassReason = 'INTENT_NO_MATCH',
  completeness: IntentCacheAccountingBinding['completeness'] = 'complete',
): IntentNormalizationBypassReceipt {
  const candidate: Record<string, unknown> = {
    schema: INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
    mode: 'shadow',
    applied: false,
    sourceDigest: SOURCE,
    normalizer: NORMALIZER,
    ontology: ONTOLOGY,
    normalizationPolicyDigest: sha256('normalization-policy'),
    cacheAdmissionPolicyDigest: sha256('cache-admission-policy'),
    reason,
    accounting: accounting(completeness),
    receiptDigest: sha256('placeholder'),
  };
  candidate.receiptDigest =
    recomputeIntentNormalizationBypassReceiptDigest(candidate);
  return parseIntentNormalizationBypassReceipt(candidate);
}

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function expectMalformed(
  parser: (value: unknown) => unknown,
  candidate: unknown,
): void {
  expect(() => parser(candidate)).toThrowError(
    expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
  );
}

describe('intent-cache operation binding', () => {
  it('parses, freezes and deterministically recomputes the binding digest', () => {
    const binding = operationBinding();
    const reordered = Object.fromEntries(Object.entries(binding).reverse());

    expect(Object.isFrozen(binding)).toBe(true);
    expect(recomputeIntentCacheOperationBindingDigest(binding)).toBe(
      binding.bindingDigest,
    );
    expect(recomputeIntentCacheOperationBindingDigest(reordered)).toBe(
      binding.bindingDigest,
    );
    expect(parseIntentCacheOperationBinding(reordered)).toEqual(binding);
  });

  it('accepts every alpha operation effect but rejects observation/response tiers', () => {
    for (const effect of ['read', 'write', 'irreversible'] as const) {
      expect(
        parseIntentCacheOperationBinding(operationBinding(effect)).effect,
      ).toBe(effect);
    }

    for (const tier of ['observation', 'response']) {
      const candidate = mutable(operationBinding()) as unknown as Record<
        string,
        unknown
      >;
      candidate.tier = tier;
      expectMalformed(parseIntentCacheOperationBinding, candidate);
    }
  });

  it('rejects tampering and non-exact operation/domain HMACs', () => {
    const tampered = mutable(operationBinding());
    tampered.intentDigest = sha256('tampered-intent');
    expect(recomputeIntentCacheOperationBindingDigest(tampered)).not.toBe(
      tampered.bindingDigest,
    );
    expectMalformed(parseIntentCacheOperationBinding, tampered);

    for (const [field, value] of [
      ['operation', `hmac-sha256:operation:${'a'.repeat(63)}`],
      ['domain', `hmac-sha256:domain:${'b'.repeat(64)}`],
    ] as const) {
      const candidate = mutable(operationBinding()) as unknown as Record<
        string,
        unknown
      >;
      candidate[field] = value;
      expectMalformed(parseIntentCacheOperationBinding, candidate);
    }
  });
});

describe('intent-cache lookup receipt', () => {
  it('accepts the complete closed outcome/reason/store-access matrix', () => {
    const readDispositions: readonly IntentCacheLookupDisposition[] = [
      {
        outcome: 'miss',
        reason: 'NO_CANDIDATE_FOUND',
        storeAccess: 'attempted',
      },
      {
        outcome: 'policy-bypass',
        reason: 'POLICY_DENY',
        storeAccess: 'not-attempted',
      },
      {
        outcome: 'policy-bypass',
        reason: 'NORMALIZATION_INELIGIBLE',
        storeAccess: 'not-attempted',
      },
      {
        outcome: 'store-fault',
        reason: 'EXPECTED_STORE_FAULT',
        storeAccess: 'attempted',
      },
      {
        outcome: 'timeout',
        reason: 'LOOKUP_TIMEOUT',
        storeAccess: 'attempted',
      },
      {
        outcome: 'fallback',
        reason: 'LOOKUP_FALLBACK',
        storeAccess: 'attempted',
      },
    ];
    for (const disposition of readDispositions) {
      const receipt = lookupReceipt({ disposition });
      expect(receipt).toMatchObject(disposition);
      expect(recomputeIntentCacheLookupReceiptDigest(receipt)).toBe(
        receipt.receiptDigest,
      );
    }

    for (const effect of ['write', 'irreversible'] as const) {
      const receipt = lookupReceipt({
        effect,
        disposition: {
          outcome: 'policy-bypass',
          reason: 'ALPHA_EFFECT_FORBIDDEN',
          storeAccess: 'not-attempted',
        },
        accountingCompleteness: 'incomplete',
      });
      expect(receipt.observedOperationBinding.effect).toBe(effect);
      expect(receipt.accounting.completeness).toBe('incomplete');
    }
  });

  it('rejects every outcome/reason/store-access mismatch and effect mismatch', () => {
    const invalid = [
      { outcome: 'miss', reason: 'LOOKUP_TIMEOUT', storeAccess: 'attempted' },
      {
        outcome: 'policy-bypass',
        reason: 'POLICY_DENY',
        storeAccess: 'attempted',
      },
      {
        outcome: 'timeout',
        reason: 'LOOKUP_TIMEOUT',
        storeAccess: 'not-attempted',
      },
    ] as const;
    for (const disposition of invalid) {
      const candidate = mutable(lookupReceipt()) as unknown as Record<
        string,
        unknown
      >;
      Object.assign(candidate, disposition);
      expectMalformed(parseIntentCacheLookupReceipt, candidate);
    }

    const readAlphaBypass = mutable(
      lookupReceipt({
        disposition: {
          outcome: 'policy-bypass',
          reason: 'POLICY_DENY',
          storeAccess: 'not-attempted',
        },
      }),
    ) as unknown as Record<string, unknown>;
    readAlphaBypass.reason = 'ALPHA_EFFECT_FORBIDDEN';
    expectMalformed(parseIntentCacheLookupReceipt, readAlphaBypass);

    const writeMiss = mutable(lookupReceipt()) as unknown as Record<
      string,
      unknown
    >;
    const operation = writeMiss.observedOperationBinding as Record<
      string,
      unknown
    >;
    operation.effect = 'write';
    operation.bindingDigest =
      recomputeIntentCacheOperationBindingDigest(operation);
    expectMalformed(parseIntentCacheLookupReceipt, writeMiss);
  });

  it('requires an integrity-valid observed operation binding and matching ontology', () => {
    const missing = mutable(lookupReceipt()) as unknown as Record<
      string,
      unknown
    >;
    delete missing.observedOperationBinding;
    expectMalformed(parseIntentCacheLookupReceipt, missing);

    const tampered = mutable(lookupReceipt());
    tampered.observedOperationBinding.intentDigest = sha256('tampered-intent');
    expectMalformed(parseIntentCacheLookupReceipt, tampered);

    const ontologyMismatch = mutable(lookupReceipt());
    ontologyMismatch.observedOperationBinding.ontologyDigest =
      sha256('other-ontology');
    ontologyMismatch.observedOperationBinding.bindingDigest =
      recomputeIntentCacheOperationBindingDigest(
        ontologyMismatch.observedOperationBinding,
      );
    expectMalformed(parseIntentCacheLookupReceipt, ontologyMismatch);
  });

  it('rejects plain source digests, malformed source/cache-key HMACs and NA dependencies', () => {
    for (const [field, value] of [
      ['sourceDigest', sha256('plain-source')],
      ['sourceDigest', 'hmac-sha256:intent-source:abc'],
      ['cacheKeyDigest', sha256('plain-cache-key')],
      ['cacheKeyDigest', `hmac-sha256:cache-key:${'A'.repeat(64)}`],
    ] as const) {
      const candidate = mutable(lookupReceipt()) as unknown as Record<
        string,
        unknown
      >;
      candidate[field] = value;
      expectMalformed(parseIntentCacheLookupReceipt, candidate);
    }

    for (const dependencyField of ['candidateIndex', 'store'] as const) {
      const candidate = mutable(lookupReceipt()) as unknown as Record<
        string,
        unknown
      >;
      const original = candidate[
        dependencyField
      ] as IntentCacheDependencyBinding;
      candidate[dependencyField] = {
        status: 'not-applicable',
        artifact: original.artifact,
      };
      expectMalformed(parseIntentCacheLookupReceipt, candidate);
    }
  });

  it('rejects disabled adapters whenever the receipt says lookup was attempted', () => {
    const attemptedDispositions: readonly IntentCacheLookupDisposition[] = [
      {
        outcome: 'miss',
        reason: 'NO_CANDIDATE_FOUND',
        storeAccess: 'attempted',
      },
      {
        outcome: 'store-fault',
        reason: 'EXPECTED_STORE_FAULT',
        storeAccess: 'attempted',
      },
      {
        outcome: 'timeout',
        reason: 'LOOKUP_TIMEOUT',
        storeAccess: 'attempted',
      },
      {
        outcome: 'fallback',
        reason: 'LOOKUP_FALLBACK',
        storeAccess: 'attempted',
      },
    ];
    for (const disposition of attemptedDispositions) {
      for (const dependencyField of ['candidateIndex', 'store'] as const) {
        const candidate = mutable(lookupReceipt({ disposition }));
        candidate[dependencyField].status = 'disabled';

        expectMalformed(parseIntentCacheLookupReceipt, candidate);
        expect(() =>
          recomputeIntentCacheLookupReceiptDigest(candidate),
        ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
      }
    }
  });

  it('accepts a digest-bound disabled dependency without treating it as NA', () => {
    const candidate = mutable(
      lookupReceipt({
        disposition: {
          outcome: 'policy-bypass',
          reason: 'POLICY_DENY',
          storeAccess: 'not-attempted',
        },
      }),
    );
    candidate.candidateIndex.status = 'disabled';
    candidate.store.status = 'disabled';
    candidate.receiptDigest =
      recomputeIntentCacheLookupReceiptDigest(candidate);

    expect(parseIntentCacheLookupReceipt(candidate).candidateIndex.status).toBe(
      'disabled',
    );
  });

  it('detects receipt tampering while recomputing without the receipt digest', () => {
    const receipt = lookupReceipt();
    const contentTamper = mutable(receipt);
    contentTamper.cacheAdmissionPolicyDigest = sha256('tampered-policy');
    expect(recomputeIntentCacheLookupReceiptDigest(contentTamper)).not.toBe(
      contentTamper.receiptDigest,
    );
    expectMalformed(parseIntentCacheLookupReceipt, contentTamper);

    const digestOnlyTamper = mutable(receipt);
    digestOnlyTamper.receiptDigest = sha256('tampered-receipt-digest');
    expect(recomputeIntentCacheLookupReceiptDigest(digestOnlyTamper)).toBe(
      receipt.receiptDigest,
    );
    expectMalformed(parseIntentCacheLookupReceipt, digestOnlyTamper);
  });

  it('enforces the closed complete/incomplete accounting union', () => {
    const completeWithDigest = mutable(lookupReceipt()) as unknown as Record<
      string,
      unknown
    >;
    completeWithDigest.accounting = {
      completeness: 'complete',
      digest: sha256('forbidden-success-digest'),
    };

    const incompleteWithoutFailure = mutable(
      lookupReceipt({ accountingCompleteness: 'incomplete' }),
    ) as unknown as Record<string, unknown>;
    incompleteWithoutFailure.accounting = { completeness: 'incomplete' };

    const incompleteWithGenericDigest = mutable(
      lookupReceipt({ accountingCompleteness: 'incomplete' }),
    ) as unknown as Record<string, unknown>;
    incompleteWithGenericDigest.accounting = {
      completeness: 'incomplete',
      digest: sha256('wrong-field'),
    };

    for (const candidate of [
      completeWithDigest,
      incompleteWithoutFailure,
      incompleteWithGenericDigest,
    ]) {
      expectMalformed(parseIntentCacheLookupReceipt, candidate);
    }
  });
});

describe('intent normalization bypass receipt', () => {
  it('accepts only the three closed bypass reasons and both accounting states', () => {
    const reasons = [
      'INTENT_NO_MATCH',
      'INTENT_COMPILER_FAILURE',
      'INTENT_REGISTRY_MISMATCH',
    ] as const;
    for (const [index, reason] of reasons.entries()) {
      const receipt = normalizationBypassReceipt(
        reason,
        index === 0 ? 'incomplete' : 'complete',
      );
      expect(receipt.reason).toBe(reason);
      expect(recomputeIntentNormalizationBypassReceiptDigest(receipt)).toBe(
        receipt.receiptDigest,
      );
    }

    const invalid = mutable(normalizationBypassReceipt()) as unknown as Record<
      string,
      unknown
    >;
    invalid.reason = 'INTENT_AMBIGUOUS';
    expectMalformed(parseIntentNormalizationBypassReceipt, invalid);
  });

  it('rejects plain/malformed source digests and receipt tampering', () => {
    for (const sourceDigest of [
      sha256('plain-source'),
      'hmac-sha256:intent-source:abc',
    ]) {
      const candidate = mutable(
        normalizationBypassReceipt(),
      ) as unknown as Record<string, unknown>;
      candidate.sourceDigest = sourceDigest;
      expectMalformed(parseIntentNormalizationBypassReceipt, candidate);
    }

    const tampered = mutable(normalizationBypassReceipt());
    tampered.reason = 'INTENT_COMPILER_FAILURE';
    expect(recomputeIntentNormalizationBypassReceiptDigest(tampered)).not.toBe(
      tampered.receiptDigest,
    );
    expectMalformed(parseIntentNormalizationBypassReceipt, tampered);

    const policyTamper = mutable(normalizationBypassReceipt());
    policyTamper.cacheAdmissionPolicyDigest = sha256(
      'other-cache-admission-policy',
    );
    expect(
      recomputeIntentNormalizationBypassReceiptDigest(policyTamper),
    ).not.toBe(policyTamper.receiptDigest);
    expectMalformed(parseIntentNormalizationBypassReceipt, policyTamper);

    const invalidPolicyDigest = mutable(
      normalizationBypassReceipt(),
    ) as unknown as Record<string, unknown>;
    invalidPolicyDigest.cacheAdmissionPolicyDigest = 'sha256:abc';
    expectMalformed(parseIntentNormalizationBypassReceipt, invalidPolicyDigest);
  });
});

describe('receipt data-only and schema isolation', () => {
  it('rejects active mode or applied delivery on both receipt schemas', () => {
    for (const [parser, fixture] of [
      [parseIntentCacheLookupReceipt, lookupReceipt],
      [parseIntentNormalizationBypassReceipt, normalizationBypassReceipt],
    ] as const) {
      for (const [field, value] of [
        ['mode', 'active'],
        ['applied', true],
      ] as const) {
        const candidate = mutable(fixture()) as unknown as Record<
          string,
          unknown
        >;
        candidate[field] = value;
        expectMalformed(parser, candidate);
      }
    }
  });

  it('rejects accessors without invoking them', () => {
    let reads = 0;
    const candidate = mutable(lookupReceipt());
    Object.defineProperty(candidate, 'sourceDigest', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return SOURCE;
      },
    });

    expectMalformed(parseIntentCacheLookupReceipt, candidate);
    expect(() =>
      recomputeIntentCacheLookupReceiptDigest(candidate),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
    expect(reads).toBe(0);
  });

  it('does not invoke the accounting-union discriminator accessor', () => {
    let reads = 0;
    const candidate = mutable(lookupReceipt()) as unknown as Record<
      string,
      unknown
    >;
    const accountingAccessor = {};
    Object.defineProperty(accountingAccessor, 'completeness', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'complete';
      },
    });
    candidate.accounting = accountingAccessor;

    expectMalformed(parseIntentCacheLookupReceipt, candidate);
    expect(reads).toBe(0);
  });

  it('rejects sparse values and unknown raw fields at root or nested levels', () => {
    const sparse = mutable(lookupReceipt()) as unknown as Record<
      string,
      unknown
    >;
    const sparseAccounting: unknown[] = [];
    sparseAccounting.length = 2;
    sparse.accounting = sparseAccounting;

    const rootUnknown = {
      ...normalizationBypassReceipt(),
      rawUtterance: 'secret',
    };
    const nestedUnknown = mutable(lookupReceipt());
    (nestedUnknown.normalizer as unknown as Record<string, unknown>).rawPrompt =
      'secret';

    expectMalformed(parseIntentCacheLookupReceipt, sparse);
    expectMalformed(parseIntentNormalizationBypassReceipt, rootUnknown);
    expectMalformed(parseIntentCacheLookupReceipt, nestedUnknown);
  });

  it('keeps operation, lookup and bypass schemas mutually invalid', () => {
    const binding = operationBinding();
    const lookup = lookupReceipt();
    const bypass = normalizationBypassReceipt();

    expectMalformed(parseIntentCacheOperationBinding, lookup);
    expectMalformed(parseIntentCacheOperationBinding, bypass);
    expectMalformed(parseIntentCacheLookupReceipt, binding);
    expectMalformed(parseIntentCacheLookupReceipt, bypass);
    expectMalformed(parseIntentNormalizationBypassReceipt, binding);
    expectMalformed(parseIntentNormalizationBypassReceipt, lookup);
  });

  it('hashes key order deterministically for both receipt schemas', () => {
    const lookup = lookupReceipt();
    const reorderedLookup = Object.fromEntries(
      Object.entries(lookup).reverse(),
    );
    expect(recomputeIntentCacheLookupReceiptDigest(reorderedLookup)).toBe(
      lookup.receiptDigest,
    );
    expect(parseIntentCacheLookupReceipt(reorderedLookup)).toEqual(lookup);

    const bypass = normalizationBypassReceipt();
    const reorderedBypass = Object.fromEntries(
      Object.entries(bypass).reverse(),
    );
    expect(
      recomputeIntentNormalizationBypassReceiptDigest(reorderedBypass),
    ).toBe(bypass.receiptDigest);
    expect(parseIntentNormalizationBypassReceipt(reorderedBypass)).toEqual(
      bypass,
    );
  });
});
