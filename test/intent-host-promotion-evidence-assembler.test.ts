import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  MAX_INTENT_CACHE_PROMOTION_EVIDENCE_LINE_BYTES,
  assembleIntentCachePromotionEvidence,
  parseIntentCachePromotionEvidenceFixture,
  parseIntentCachePromotionEvidenceJsonl,
  recomputeIntentCachePromotionEvidenceBindingDigest,
  recomputeIntentCachePromotionEvidenceCaseDigest,
  type IntentCachePromotionEvidenceAssemblyInput,
  type IntentCachePromotionEvidenceAttestation,
  type IntentCachePromotionEvidenceCase,
  type IntentCachePromotionEvidenceFixture,
} from '../src/intent-host/index.js';
import {
  createSideEffectIntentPromotionFixture,
  createUnsafeHitIntentPromotionFixture,
} from './support/intent-promotion-qualification-fixture.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

interface MutableAssemblyInput {
  attestation: DeepMutable<IntentCachePromotionEvidenceAttestation>;
  cases: DeepMutable<IntentCachePromotionEvidenceCase>[];
}

function trappedProxy<T extends object>(
  target: T,
): {
  readonly value: T;
  readonly trapCount: () => number;
} {
  let traps = 0;
  const handler: ProxyHandler<T> = {
    get(value, field, receiver) {
      traps += 1;
      return Reflect.get(value, field, receiver);
    },
    getOwnPropertyDescriptor(value, field) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(value, field);
    },
    getPrototypeOf(value) {
      traps += 1;
      return Reflect.getPrototypeOf(value);
    },
    ownKeys(value) {
      traps += 1;
      return Reflect.ownKeys(value);
    },
  };
  return {
    value: new Proxy(target, handler),
    trapCount: () => traps,
  };
}

function mockCanonicalCaseRecordBytes(bytes: number) {
  const originalByteLength = Buffer.byteLength.bind(Buffer);
  return vi
    .spyOn(Buffer, 'byteLength')
    .mockImplementation((value, encoding) => {
      if (
        typeof value === 'string' &&
        value.includes('"caseDigest":') &&
        value.includes('"stateSnapshotDigest":') &&
        value.includes('"usage":')
      ) {
        return bytes;
      }
      return originalByteLength(value, encoding);
    });
}

function attestationFrom(
  fixture: IntentCachePromotionEvidenceFixture,
): IntentCachePromotionEvidenceAttestation {
  const binding = structuredClone(fixture.binding);
  return {
    qualifiedOperation: {
      operation: binding.qualifiedOperation.operation,
      domain: binding.qualifiedOperation.domain,
    },
    scope: binding.scope,
    validity: binding.validity,
    intentContract: {
      ontology: binding.intentContract.ontology,
      normalizer: binding.intentContract.normalizer,
      operationRegistry: binding.intentContract.operationRegistry,
      resolver: binding.intentContract.resolver,
      normalizationPolicyDigest:
        binding.intentContract.normalizationPolicyDigest,
      cacheAdmissionPolicyDigest:
        binding.intentContract.cacheAdmissionPolicyDigest,
      sourceHmacKeyVersionDigest:
        binding.intentContract.sourceHmacKeyVersionDigest,
    },
    dependencies: binding.dependencies,
    population: {
      populationFrameDigest: binding.population.populationFrameDigest,
      sourceLogRootDigest: binding.population.sourceLogRootDigest,
      samplingProtocolDigest: binding.population.samplingProtocolDigest,
      inclusionPolicyDigest: binding.population.inclusionPolicyDigest,
      samplingWindowDigest: binding.population.samplingWindowDigest,
      attempted: binding.population.attempted,
    },
    adversarial: {
      coverageDigest: binding.adversarial.coverageDigest,
      expected: binding.adversarial.expected,
    },
    evaluation: {
      evaluationProtocolDigest: binding.evaluation.evaluationProtocolDigest,
      evaluatorDigest: binding.evaluation.evaluatorDigest,
      oracleDigest: binding.evaluation.oracleDigest,
      accountingContractDigest: binding.evaluation.accountingContractDigest,
      costModel: binding.evaluation.costModel,
      currencyUnitDigest: binding.evaluation.currencyUnitDigest,
    },
  };
}

function mutableInput(
  fixture: IntentCachePromotionEvidenceFixture,
): MutableAssemblyInput {
  return {
    attestation: structuredClone(attestationFrom(fixture)),
    cases: structuredClone(fixture.cases),
  } as MutableAssemblyInput;
}

function resealCase(item: DeepMutable<IntentCachePromotionEvidenceCase>): void {
  item.caseDigest = recomputeIntentCachePromotionEvidenceCaseDigest(item);
}

function mixedInput(): MutableAssemblyInput {
  const population = mutableInput(createUnsafeHitIntentPromotionFixture());
  const adversarial = mutableInput(createSideEffectIntentPromotionFixture());
  const populationCase = population.cases[0];
  const adversarialCase = adversarial.cases[0];
  if (populationCase === undefined || adversarialCase === undefined) {
    throw new TypeError('promotion fixture is unexpectedly empty');
  }
  adversarialCase.ordinal = 1;
  adversarialCase.usage.ordinary.traceDigest = sha256(
    'mixed adversarial ordinary trace',
  );
  adversarialCase.usage.candidate.traceDigest = sha256(
    'mixed adversarial candidate trace',
  );
  resealCase(adversarialCase);
  population.attestation.adversarial.expected = 1;
  population.cases = [populationCase, adversarialCase];
  return population;
}

function expectMalformed(value: unknown): void {
  expect(() =>
    assembleIntentCachePromotionEvidence(
      value as IntentCachePromotionEvidenceAssemblyInput,
    ),
  ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
}

describe('authoritative intent-cache promotion evidence assembly', () => {
  it('derives only aggregate counters and digests, then revalidates the fixture', () => {
    const input = mixedInput();
    const populationCaseDigest = input.cases[0]?.caseDigest;
    const adversarialCaseDigest = input.cases[1]?.caseDigest;
    const assembled = assembleIntentCachePromotionEvidence(input);

    expect(assembled.binding.population).toMatchObject({
      attempted: 1,
      emitted: 1,
      dropped: 0,
      complete: 1,
      failed: 0,
    });
    expect(assembled.binding.adversarial).toMatchObject({
      expected: 1,
      emitted: 1,
      complete: 1,
      failed: 0,
    });
    expect(assembled.binding.qualifiedOperation.effect).toBe('read');
    expect(assembled.binding.intentContract.intentIrSchema).toBe(
      'semwitness.dev/intent-ir/v1alpha1',
    );
    expect(assembled.binding.population.independenceUnit).toBe('cluster');
    expect(assembled.binding.evaluation.split).toBe('held-out');
    expect(assembled.cases.map((item) => item.caseDigest)).toEqual([
      populationCaseDigest,
      adversarialCaseDigest,
    ]);
    expect(assembled.binding.bindingDigest).toBe(
      recomputeIntentCachePromotionEvidenceBindingDigest(assembled.binding),
    );
    expect(parseIntentCachePromotionEvidenceFixture(assembled)).toEqual(
      assembled,
    );
    expect(
      parseIntentCachePromotionEvidenceJsonl(
        [assembled.binding, ...assembled.cases]
          .map((record) => JSON.stringify(record))
          .join('\n'),
      ),
    ).toEqual(assembled);
  });

  it('takes a detached, deeply frozen snapshot that later caller mutation cannot change', () => {
    const input = mutableInput(createUnsafeHitIntentPromotionFixture());
    const assembled = assembleIntentCachePromotionEvidence(input);
    const originalDigest = assembled.cases[0]?.caseDigest;

    input.attestation.population.attempted = 99;
    const first = input.cases[0];
    if (first !== undefined) first.caseDigest = sha256('caller mutation');

    expect(assembled.binding.population.attempted).toBe(1);
    expect(assembled.cases[0]?.caseDigest).toBe(originalDigest);
    expect(assembled.cases[0]).not.toBe(input.cases[0]);
    expect(Object.isFrozen(assembled)).toBe(true);
    expect(Object.isFrozen(assembled.binding.population)).toBe(true);
    expect(Object.isFrozen(assembled.cases[0])).toBe(true);
  });

  it('requires every declared population attempt and adversarial case', () => {
    const missingPopulation = mutableInput(
      createUnsafeHitIntentPromotionFixture(),
    );
    missingPopulation.cases = [];
    expectMalformed(missingPopulation);

    const missingAdversarial = mixedInput();
    missingAdversarial.attestation.adversarial.expected = 2;
    expectMalformed(missingAdversarial);
  });

  it('rejects a declared-count mismatch before reading any case record', () => {
    const input = mutableInput(createUnsafeHitIntentPromotionFixture());
    const unread = trappedProxy({ untrusted: true });
    input.attestation.population.attempted = 2;
    input.cases = [
      unread.value as unknown as DeepMutable<IntentCachePromotionEvidenceCase>,
    ];

    expectMalformed(input);
    expect(unread.trapCount()).toBe(0);
  });

  it('rejects aggregate object evidence beyond the line-terminated 128 MiB budget', () => {
    const input = mutableInput(createUnsafeHitIntentPromotionFixture());
    const item = input.cases[0];
    if (item === undefined) throw new TypeError('fixture is empty');
    const caseCount = 513;
    input.attestation.population.attempted = caseCount;
    input.cases = Array.from({ length: caseCount }, () => item);
    const byteLength = mockCanonicalCaseRecordBytes(
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_LINE_BYTES,
    );
    try {
      expect(() => assembleIntentCachePromotionEvidence(input)).toThrowError(
        /Evidence document exceeds the byte limit/u,
      );
    } finally {
      byteLength.mockRestore();
    }
  });

  it('rejects a parser-normalized object record above the JSONL line cap', () => {
    const input = mutableInput(createUnsafeHitIntentPromotionFixture());
    const byteLength = mockCanonicalCaseRecordBytes(
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_LINE_BYTES + 1,
    );
    try {
      expect(() => assembleIntentCachePromotionEvidence(input)).toThrowError(
        /Evidence case exceeds the line byte limit/u,
      );
    } finally {
      byteLength.mockRestore();
    }
  });

  it('rejects proxies at container, record, and nested boundaries without invoking traps', () => {
    const topInput = mutableInput(createUnsafeHitIntentPromotionFixture());
    const top = trappedProxy(topInput);
    expectMalformed(top.value);
    expect(top.trapCount()).toBe(0);

    const arrayInput = mutableInput(createUnsafeHitIntentPromotionFixture());
    const array = trappedProxy(arrayInput.cases);
    arrayInput.cases = array.value;
    expectMalformed(arrayInput);
    expect(array.trapCount()).toBe(0);

    const caseInput = mutableInput(createUnsafeHitIntentPromotionFixture());
    const item = caseInput.cases[0];
    if (item === undefined) throw new TypeError('fixture is empty');
    const record = trappedProxy(item);
    caseInput.cases[0] = record.value;
    expectMalformed(caseInput);
    expect(record.trapCount()).toBe(0);

    const nestedInput = mutableInput(createUnsafeHitIntentPromotionFixture());
    const operation = trappedProxy(nestedInput.attestation.qualifiedOperation);
    nestedInput.attestation.qualifiedOperation = operation.value;
    expectMalformed(nestedInput);
    expect(operation.trapCount()).toBe(0);
  });

  it('rejects ordinal gaps and cohort reordering instead of sorting records', () => {
    const ordinalGap = mutableInput(createUnsafeHitIntentPromotionFixture());
    const first = ordinalGap.cases[0];
    if (first === undefined) throw new TypeError('fixture is empty');
    first.ordinal = 1;
    resealCase(first);
    expectMalformed(ordinalGap);

    const reordered = mixedInput();
    const population = reordered.cases[0];
    const adversarial = reordered.cases[1];
    if (population === undefined || adversarial === undefined) {
      throw new TypeError('fixture is empty');
    }
    adversarial.ordinal = 0;
    population.ordinal = 1;
    resealCase(adversarial);
    resealCase(population);
    reordered.cases = [adversarial, population];
    expectMalformed(reordered);
  });

  it('never repairs or fabricates a case digest, usage observation, or oracle', () => {
    const wrongDigest = mutableInput(createUnsafeHitIntentPromotionFixture());
    const digestCase = wrongDigest.cases[0];
    if (digestCase === undefined) throw new TypeError('fixture is empty');
    digestCase.caseDigest = sha256('untrusted case digest');
    expectMalformed(wrongDigest);

    const missingUsage = mutableInput(createUnsafeHitIntentPromotionFixture());
    const usageCase = missingUsage.cases[0];
    if (usageCase === undefined) throw new TypeError('fixture is empty');
    delete (usageCase as unknown as { usage?: unknown }).usage;
    expectMalformed(missingUsage);

    const missingOracle = mutableInput(createUnsafeHitIntentPromotionFixture());
    const oracleCase = missingOracle.cases[0];
    if (
      oracleCase?.kind !== 'population-complete' ||
      oracleCase.path.kind !== 'candidate-bearing'
    ) {
      throw new TypeError('fixture shape changed');
    }
    delete (oracleCase.path as unknown as { oracle?: unknown }).oracle;
    expectMalformed(missingOracle);
  });

  it('rejects accessors without invoking them, sparse arrays, custom prototypes, and derived input fields', () => {
    let reads = 0;
    const accessor = mutableInput(createUnsafeHitIntentPromotionFixture());
    Object.defineProperty(accessor, 'attestation', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return attestationFrom(createUnsafeHitIntentPromotionFixture());
      },
    });
    expectMalformed(accessor);
    expect(reads).toBe(0);

    const sparse = mutableInput(createUnsafeHitIntentPromotionFixture());
    const sparseCases: DeepMutable<IntentCachePromotionEvidenceCase>[] = [];
    sparseCases.length = 1;
    sparse.cases = sparseCases;
    expectMalformed(sparse);

    const prototype = mutableInput(createUnsafeHitIntentPromotionFixture());
    Object.setPrototypeOf(prototype.attestation, { inherited: true });
    expectMalformed(prototype);

    const injectedProtocol = mutableInput(
      createUnsafeHitIntentPromotionFixture(),
    );
    (injectedProtocol.attestation as unknown as Record<string, unknown>).mode =
      'active';
    expectMalformed(injectedProtocol);

    for (const inject of [
      (value: MutableAssemblyInput) => {
        (
          value.attestation.qualifiedOperation as unknown as Record<
            string,
            unknown
          >
        ).effect = 'write';
      },
      (value: MutableAssemblyInput) => {
        (
          value.attestation.intentContract as unknown as Record<string, unknown>
        ).intentIrSchema = 'caller-controlled';
      },
      (value: MutableAssemblyInput) => {
        (
          value.attestation.population as unknown as Record<string, unknown>
        ).independenceUnit = 'event';
      },
      (value: MutableAssemblyInput) => {
        (
          value.attestation.evaluation as unknown as Record<string, unknown>
        ).split = 'training';
      },
    ]) {
      const injectedInvariant = mutableInput(
        createUnsafeHitIntentPromotionFixture(),
      );
      inject(injectedInvariant);
      expectMalformed(injectedInvariant);
    }

    const injectedAggregate = mutableInput(
      createUnsafeHitIntentPromotionFixture(),
    );
    (
      injectedAggregate.attestation.population as unknown as Record<
        string,
        unknown
      >
    ).complete = 1;
    expectMalformed(injectedAggregate);
  });
});
