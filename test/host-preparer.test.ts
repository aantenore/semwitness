import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSemWitness,
  type SemWitnessCore,
} from '../src/composition-root.js';
import { sha256 } from '../src/domain/hash.js';
import { digestPolicy, type CodecPolicy } from '../src/domain/policy.js';
import {
  finalizeProof,
  recomputeProofDigest,
  type ProofEnvelope,
} from '../src/domain/proof.js';
import {
  HOST_PREPARER_ARTIFACT,
  createVerifiedTextRequestPreparer,
  digestHostPromotionManifest,
  isHostReasonCode,
  parseHostPromotionManifest,
  type HostPromotionManifest,
  type TextPreparationRequest,
} from '../src/host/index.js';
import { DeterministicByteTokenizer, makePolicy } from './helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

interface Fixture {
  readonly core: SemWitnessCore;
  readonly policy: CodecPolicy;
  readonly promotion: HostPromotionManifest;
  readonly request: TextPreparationRequest;
}

const temporaryRoots = new Set<string>();
const DEPLOYMENT_SCOPE_DIGEST = sha256('ai-sdk-v4:test-model:lookup:v1');

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-host-test-'));
  temporaryRoots.add(root);
  return root;
}

async function fixture(options?: {
  readonly reliability?: 'exact' | 'heuristic';
  readonly mode?: CodecPolicy['mode'];
  readonly allowHeuristicApply?: boolean;
}): Promise<Fixture> {
  const policy = makePolicy({
    mode: options?.mode ?? 'apply-verified',
    selection: {
      includeDecoderLegendTokens: false,
      minTokenSavings: 1,
      minSavingsRatioPpm: 0,
      allowHeuristicApply: options?.allowHeuristicApply ?? false,
    },
  });
  const tokenizer = new DeterministicByteTokenizer(
    policy.tokenizerId,
    options?.reliability ?? 'exact',
  );
  const core = createSemWitness({
    storeRoot: await temporaryRoot(),
    policy,
    tokenizer,
  });
  const request: TextPreparationRequest = Object.freeze({
    id: 'host-json-case',
    role: 'tool',
    kind: 'json-data',
    trust: 'workspace-trusted',
    mediaType: 'application/json',
    equivalence: 'typed-semantic',
    deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
    content: `{
  "records": [
    { "id": 1, "state": "ready", "enabled": true },
    { "id": 2, "state": "ready", "enabled": true },
    { "id": 3, "state": "ready", "enabled": true }
  ],
  "owner": "host-test"
}`,
  });
  const promotion = promotionFor(core, policy);
  return { core, policy, promotion, request };
}

function promotionFor(
  core: SemWitnessCore,
  policy: CodecPolicy,
  codecs: HostPromotionManifest['codecs'] = [{ id: 'json-jcs', version: '1' }],
): HostPromotionManifest {
  return {
    schema: 'semwitness.dev/host-promotion/v1alpha1',
    artifact: { ...HOST_PREPARER_ARTIFACT },
    policyDigest: digestPolicy(policy),
    deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
    tokenizer: {
      id: core.tokenizer.id,
      fingerprint: core.tokenizer.fingerprint,
    },
    codecs,
    evaluation: {
      corpusDigest: sha256('held-out-host-corpus-v1'),
      reportDigest: sha256('held-out-host-report-v1'),
      split: 'held-out',
      unsafeAccepts: 0,
      taskQualityRegressions: 0,
      medianNetSavingsRatioPpm: 250_000,
    },
  };
}

function mutablePromotion(
  promotion: HostPromotionManifest,
): DeepMutable<HostPromotionManifest> {
  return structuredClone(promotion) as DeepMutable<HostPromotionManifest>;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('host promotion manifest', () => {
  it('parses, freezes and hashes a fully bound held-out promotion', async () => {
    const { promotion } = await fixture();
    const parsed = parseHostPromotionManifest(promotion);

    expect(parsed).toEqual(promotion);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.artifact)).toBe(true);
    expect(Object.isFrozen(parsed.codecs)).toBe(true);
    expect(Object.isFrozen(parsed.codecs[0])).toBe(true);
    expect(digestHostPromotionManifest(parsed)).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(digestHostPromotionManifest(parsed)).toBe(
      digestHostPromotionManifest(parseHostPromotionManifest(promotion)),
    );
  });

  it('strictly rejects extra fields at every manifest level', async () => {
    const { core, policy, promotion } = await fixture();
    const rootExtra = { ...promotion, sourcePayload: 'must-not-be-accepted' };
    const artifactExtra = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & {
      artifact: DeepMutable<HostPromotionManifest['artifact']> & {
        extra?: string;
      };
    };
    artifactExtra.artifact.extra = 'unexpected';
    const tokenizerExtra = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & {
      tokenizer: DeepMutable<HostPromotionManifest['tokenizer']> & {
        extra?: string;
      };
    };
    tokenizerExtra.tokenizer.extra = 'unexpected';
    const codecExtra = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & {
      codecs: (DeepMutable<HostPromotionManifest['codecs'][number]> & {
        extra?: string;
      })[];
    };
    codecExtra.codecs[0]!.extra = 'unexpected';
    const evaluationExtra = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & {
      evaluation: DeepMutable<HostPromotionManifest['evaluation']> & {
        extra?: string;
      };
    };
    evaluationExtra.evaluation.extra = 'unexpected';

    for (const candidate of [
      rootExtra,
      artifactExtra,
      tokenizerExtra,
      codecExtra,
      evaluationExtra,
    ]) {
      expect(() => parseHostPromotionManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
      );
    }
    expect(() =>
      createVerifiedTextRequestPreparer(
        core,
        policy,
        rootExtra as HostPromotionManifest,
      ),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects unsorted or duplicate codec allowlists', async () => {
    const { promotion } = await fixture();
    const unsorted = mutablePromotion(promotion);
    unsorted.codecs = [
      { id: 'whitespace-rle', version: '1' },
      { id: 'json-jcs', version: '1' },
    ];
    const duplicate = mutablePromotion(promotion);
    duplicate.codecs = [
      { id: 'json-jcs', version: '1' },
      { id: 'json-jcs', version: '1' },
    ];

    expect(() => parseHostPromotionManifest(unsorted)).toThrow();
    expect(() => parseHostPromotionManifest(duplicate)).toThrow();
  });

  it('enforces held-out safety, quality and median net-savings gates', async () => {
    const { promotion } = await fixture();
    const invalid: unknown[] = [];
    for (const [key, value] of [
      ['split', 'training'],
      ['unsafeAccepts', 1],
      ['taskQualityRegressions', 1],
      ['medianNetSavingsRatioPpm', 99_999],
      ['medianNetSavingsRatioPpm', 1_000_001],
    ] as const) {
      const candidate = mutablePromotion(promotion);
      (candidate.evaluation as Record<string, unknown>)[key] = value;
      invalid.push(candidate);
    }

    for (const candidate of invalid) {
      expect(() => parseHostPromotionManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
      );
    }
  });

  it('rejects symbols, hidden fields and accessors without invoking getters', async () => {
    const { promotion } = await fixture();
    const symbolField = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & Record<PropertyKey, unknown>;
    symbolField[Symbol('hidden-source')] = 'must-not-pass';

    const hiddenField = mutablePromotion(
      promotion,
    ) as DeepMutable<HostPromotionManifest> & Record<string, unknown>;
    Object.defineProperty(hiddenField, 'hidden', {
      value: 'must-not-pass',
      enumerable: false,
    });

    let rootGetterReads = 0;
    const rootAccessor = mutablePromotion(promotion);
    Object.defineProperty(rootAccessor, 'policyDigest', {
      enumerable: true,
      configurable: true,
      get() {
        rootGetterReads += 1;
        return promotion.policyDigest;
      },
    });

    let ratioGetterReads = 0;
    const ratioAccessor = mutablePromotion(promotion);
    Object.defineProperty(
      ratioAccessor.evaluation,
      'medianNetSavingsRatioPpm',
      {
        enumerable: true,
        configurable: true,
        get() {
          ratioGetterReads += 1;
          return ratioGetterReads === 1 ? 250_000 : 0;
        },
      },
    );

    for (const candidate of [
      symbolField,
      hiddenField,
      rootAccessor,
      ratioAccessor,
    ]) {
      expect(() => parseHostPromotionManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
      );
    }
    expect(() => digestHostPromotionManifest(rootAccessor)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
    );
    expect(() => digestHostPromotionManifest(ratioAccessor)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
    );
    expect(rootGetterReads).toBe(0);
    expect(ratioGetterReads).toBe(0);
  });

  it('requires a dense data-only codec array without extra properties', async () => {
    const { promotion } = await fixture();
    const hole = mutablePromotion(promotion);
    const sparse: DeepMutable<HostPromotionManifest['codecs'][number]>[] = [];
    sparse.length = 1;
    hole.codecs = sparse;

    const extra = mutablePromotion(promotion);
    (extra.codecs as typeof extra.codecs & { extra?: string }).extra =
      'unexpected';

    let indexGetterReads = 0;
    const accessor = mutablePromotion(promotion);
    Object.defineProperty(accessor.codecs, '0', {
      enumerable: true,
      configurable: true,
      get() {
        indexGetterReads += 1;
        return promotion.codecs[0];
      },
    });

    const hiddenIndex = mutablePromotion(promotion);
    Object.defineProperty(hiddenIndex.codecs, '0', {
      value: hiddenIndex.codecs[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });

    for (const candidate of [hole, extra, accessor, hiddenIndex]) {
      expect(() => parseHostPromotionManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
      );
    }
    expect(indexGetterReads).toBe(0);
  });

  it('reparses unknown input before computing a promotion digest', async () => {
    const { promotion } = await fixture();
    expect(digestHostPromotionManifest(promotion)).toBe(
      digestHostPromotionManifest(parseHostPromotionManifest(promotion)),
    );
    expect(() => digestHostPromotionManifest({})).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }),
    );
    expect(() =>
      digestHostPromotionManifest({
        ...promotion,
        unexpected: 'not-data-only',
      }),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });
});

describe('verified text request preparer', () => {
  it('applies a retrieved, reverified canonical JSON candidate', async () => {
    const { core, policy, promotion, request } = await fixture();
    const preparer = createVerifiedTextRequestPreparer(core, policy, promotion);

    const result = await preparer.prepare(request);

    expect(result.applied).toBe(true);
    expect(result.selectedCodec).toBe('json-jcs');
    expect(result.reasons).toEqual(['APPLIED']);
    expect(result.content.length).toBeLessThan(request.content.length);
    expect(JSON.parse(result.content)).toEqual(JSON.parse(request.content));
    expect(result.proof).toMatchObject({
      decision: { status: 'applied', reasons: ['APPLIED'] },
      codec: { id: 'json-jcs', version: '1' },
      tokenEvidence: [{ reliability: 'exact' }],
    });
    expect(result.promotionDigest).toBe(
      digestHostPromotionManifest(parseHostPromotionManifest(promotion)),
    );
    expect(result.deploymentScopeDigest).toBe(DEPLOYMENT_SCOPE_DIGEST);
  });

  it('constructs without a promotion and never invokes the core', async () => {
    const { core: base, policy, request } = await fixture();
    let simulations = 0;
    const core: SemWitnessCore = {
      ...base,
      async simulate() {
        simulations += 1;
        throw new Error('must not run');
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
    ).prepare(request);

    expect(result).toMatchObject({
      content: request.content,
      applied: false,
      selectedCodec: 'identity',
      reasons: ['PROMOTION_MISSING'],
    });
    expect(result.promotionDigest).toBeUndefined();
    expect(result.deploymentScopeDigest).toBeUndefined();
    expect(result.proof).toBeUndefined();
    expect(simulations).toBe(0);
  });

  it('keeps shadow policy as identity even with a matching promotion', async () => {
    const { core, policy, promotion, request } = await fixture({
      mode: 'shadow',
    });
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['POLICY_MODE_NOT_APPLY_VERIFIED']);
  });

  it('fails closed on artifact, policy and tokenizer promotion mismatches', async () => {
    const { core, policy, promotion, request } = await fixture();
    const cases: readonly [HostPromotionManifest, string][] = [
      [
        {
          ...promotion,
          artifact: { ...promotion.artifact, version: '2' },
        },
        'PROMOTION_ARTIFACT_MISMATCH',
      ],
      [
        { ...promotion, policyDigest: sha256('different-policy') },
        'PROMOTION_POLICY_MISMATCH',
      ],
      [
        {
          ...promotion,
          tokenizer: {
            ...promotion.tokenizer,
            fingerprint: 'test/other-tokenizer:exact',
          },
        },
        'PROMOTION_TOKENIZER_MISMATCH',
      ],
    ];

    for (const [candidate, expectedReason] of cases) {
      const result = await createVerifiedTextRequestPreparer(
        core,
        policy,
        candidate,
      ).prepare(request);
      expect(result.content).toBe(request.content);
      expect(result.applied).toBe(false);
      expect(result.reasons).toContain(expectedReason);
      expect(result.reasons.every(isHostReasonCode)).toBe(true);
    }

    const inconsistentPolicy = makePolicy({
      mode: 'apply-verified',
      tokenizerId: 'different-tokenizer',
    });
    const inconsistent = await createVerifiedTextRequestPreparer(
      core,
      inconsistentPolicy,
      promotionFor(core, inconsistentPolicy),
    ).prepare(request);
    expect(inconsistent.content).toBe(request.content);
    expect(inconsistent.reasons).toEqual(['PROMOTION_TOKENIZER_MISMATCH']);
  });

  it('rejects a deployment-scope mismatch before simulation', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    let simulations = 0;
    const core: SemWitnessCore = {
      ...base,
      async simulate(segment, candidate) {
        simulations += 1;
        return base.simulate(segment, candidate);
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare({
      ...request,
      deploymentScopeDigest: sha256('different-deployment-scope'),
    });

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['PROMOTION_SCOPE_MISMATCH']);
    expect(result.promotionDigest).toBe(digestHostPromotionManifest(promotion));
    expect(result.deploymentScopeDigest).toBe(DEPLOYMENT_SCOPE_DIGEST);
    expect(simulations).toBe(0);
  });

  it('rejects an applied codec absent from the promoted allowlist', async () => {
    const { core, policy, request } = await fixture();
    const promotion = promotionFor(core, policy, [
      { id: 'identity', version: '1' },
    ]);
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.selectedCodec).toBe('json-jcs');
    expect(result.reasons).toEqual(['PROMOTION_CODEC_MISMATCH']);
  });

  it('requires exact proof token evidence even when core policy permits heuristics', async () => {
    const { core, policy, promotion, request } = await fixture({
      reliability: 'heuristic',
      allowHeuristicApply: true,
    });
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['PROOF_TOKEN_EVIDENCE_INVALID']);
    expect(result.proof?.tokenEvidence).toEqual([
      expect.objectContaining({ reliability: 'heuristic' }),
    ]);
  });

  it('keeps decoder-dependent codecs shadow-only at the alpha host boundary', async () => {
    const policy = makePolicy({
      mode: 'apply-verified',
      rules: [
        {
          match: { kinds: ['tool-result'] },
          codecs: ['identity', 'whitespace-rle'],
          allowEquivalence: ['byte-exact', 'roundtrip-exact'],
        },
        {
          match: {},
          codecs: ['identity'],
          allowEquivalence: ['byte-exact'],
        },
      ],
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
      },
    });
    const core = createSemWitness({
      storeRoot: await temporaryRoot(),
      policy,
      tokenizer: new DeterministicByteTokenizer(policy.tokenizerId, 'exact'),
    });
    const request: TextPreparationRequest = {
      id: 'rle-host-case',
      role: 'tool',
      kind: 'tool-result',
      trust: 'workspace-trusted',
      mediaType: 'text/plain; charset=utf-8',
      equivalence: 'roundtrip-exact',
      deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
      content: `prefix${' '.repeat(512)}suffix`,
    };
    const promotion = promotionFor(core, policy, [
      { id: 'whitespace-rle', version: '1' },
    ]);
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.proof?.decision.status).toBe('applied');
    expect(result.selectedCodec).toBe('whitespace-rle');
    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['ACTIVE_DELIVERY_UNSUPPORTED']);
  });

  it('does not actively rewrite JSON from a non-tool role', async () => {
    const { core, policy, promotion, request } = await fixture();
    const userJson: TextPreparationRequest = { ...request, role: 'user' };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(userJson);

    expect(result.proof?.decision.status).toBe('applied');
    expect(result.content).toBe(userJson.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['ACTIVE_DELIVERY_UNSUPPORTED']);
  });

  it('preserves malformed requests and non-applicable simulations', async () => {
    const { core, policy, promotion, request } = await fixture();
    const invalidRequest = {
      ...request,
      id: 'NOT SAFE',
    } as TextPreparationRequest;
    const malformedJson = { ...request, content: '{ duplicate: nope' };

    const preparer = createVerifiedTextRequestPreparer(core, policy, promotion);
    const invalid = await preparer.prepare(invalidRequest);
    const bypassed = await preparer.prepare(malformedJson);

    expect(invalid).toMatchObject({
      content: invalidRequest.content,
      applied: false,
      reasons: ['REQUEST_INVALID'],
    });
    expect(bypassed).toMatchObject({
      content: malformedJson.content,
      applied: false,
      selectedCodec: 'identity',
      reasons: ['SIMULATION_BYPASSED'],
    });
  });

  it('normalizes simulation exceptions to a content-free fallback reason', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const secret = 'SOURCE_SECRET_73b85e67';
    const original = `${request.content}\n${secret}`;
    const core: SemWitnessCore = {
      ...base,
      async simulate() {
        throw new Error(`provider leaked ${secret}`);
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare({ ...request, content: original });

    expect(result.content).toBe(original);
    expect(result.reasons).toEqual(['SIMULATION_FAILED']);
    expect(JSON.stringify(result.reasons)).not.toContain(secret);
    expect(result.proof).toBeUndefined();
  });

  it('rejects unpaired and inverted UTF-16 before the real core can transform it', async () => {
    const { core, policy, promotion, request } = await fixture();
    const preparer = createVerifiedTextRequestPreparer(core, policy, promotion);

    for (const suffix of ['\ud800', '\udc00', '\udc00\ud800']) {
      const original = `${request.content}${suffix}`;
      const result = await preparer.prepare({ ...request, content: original });
      expect(result.content).toBe(original);
      expect(result.content.endsWith(suffix)).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.selectedCodec).toBe('identity');
      expect(result.reasons).toEqual(['INVALID_UTF8']);
      expect(result.proof).toBeUndefined();
    }
  });

  it('preserves astral, combining and JSON line-separator Unicode exactly', async () => {
    const { core, policy, promotion, request } = await fixture();
    const preparer = createVerifiedTextRequestPreparer(core, policy, promotion);

    for (const marker of [
      'astral-🚀',
      'combining-e\u0301',
      'line\u2028paragraph\u2029',
    ]) {
      const content = request.content.replace('host-test', marker);
      const result = await preparer.prepare({ ...request, content });
      expect(result.applied).toBe(true);
      expect(JSON.parse(result.content)).toEqual(JSON.parse(content));
      expect((JSON.parse(result.content) as { owner: string }).owner).toBe(
        marker,
      );
    }
  });

  it('guards null and hostile runtime request objects without leaking errors', async () => {
    const { core, policy, promotion, request } = await fixture();
    const preparer = createVerifiedTextRequestPreparer(core, policy, promotion);
    const nullResult = await preparer.prepare(
      null as unknown as TextPreparationRequest,
    );
    expect(nullResult).toMatchObject({
      content: '',
      applied: false,
      reasons: ['REQUEST_INVALID'],
    });

    const sentinel = 'EXACT_ORIGINAL_8e44e72f';
    const hostile = new Proxy(
      { ...request, content: sentinel },
      {
        get(target, property, receiver) {
          if (property === 'id') {
            throw new Error('SOURCE_SECRET_must_not_escape');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const hostileResult = await preparer.prepare(hostile);
    expect(hostileResult.content).toBe(sentinel);
    expect(hostileResult.reasons).toEqual(['REQUEST_INVALID']);
    expect(JSON.stringify(hostileResult.reasons)).not.toContain(
      'SOURCE_SECRET',
    );

    const throwingContent = new Proxy(request, {
      get(_target, property) {
        if (property === 'content') {
          throw new Error('SOURCE_SECRET_content_getter');
        }
        return undefined;
      },
    });
    const throwingResult = await preparer.prepare(throwingContent);
    expect(throwingResult.content).toBe('');
    expect(throwingResult.reasons).toEqual(['RUNTIME_ERROR']);
    expect(JSON.stringify(throwingResult.reasons)).not.toContain(
      'SOURCE_SECRET',
    );
  });

  it('snapshots every request field exactly once before asynchronous work', async () => {
    const { core, policy, promotion, request } = await fixture();
    const fields = [
      'id',
      'role',
      'kind',
      'trust',
      'mediaType',
      'equivalence',
      'deploymentScopeDigest',
      'content',
    ] as const satisfies readonly (keyof TextPreparationRequest)[];
    const reads = Object.create(null) as Record<
      (typeof fields)[number],
      number
    >;
    const changed: Readonly<Record<(typeof fields)[number], unknown>> = {
      id: 'NOT SAFE',
      role: 'user',
      kind: 'prose',
      trust: 'invalid-trust',
      mediaType: 'text/plain',
      equivalence: 'byte-exact',
      deploymentScopeDigest: sha256('changed-after-first-read'),
      content: '{malformed-after-first-read',
    };
    const liveRequest: Record<string, unknown> = {};
    for (const field of fields) {
      Object.defineProperty(liveRequest, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          return reads[field] === 1 ? request[field] : changed[field];
        },
      });
    }

    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(liveRequest as unknown as TextPreparationRequest);

    expect(result.applied).toBe(true);
    expect(JSON.parse(result.content)).toEqual(JSON.parse(request.content));
    expect(
      Object.fromEntries(fields.map((field) => [field, reads[field]])),
    ).toEqual(Object.fromEntries(fields.map((field) => [field, 1])));
  });

  it('detects inconsistent applied decisions before retrieval', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const core: SemWitnessCore = {
      ...base,
      async simulate(segment, candidate) {
        const simulation = await base.simulate(segment, candidate);
        return { ...simulation, projectedStored: false };
      },
      async retrieve() {
        throw new Error('must not retrieve');
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.reasons).toEqual(['PROOF_DECISION_INVALID']);
  });

  it('rejects accessor, hostile proxy and malformed live proofs before host verification', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    let accessorReads = 0;
    const proofFactories: readonly ((proof: ProofEnvelope) => unknown)[] = [
      (proof) => {
        const accessor = structuredClone(proof) as DeepMutable<ProofEnvelope>;
        Object.defineProperty(accessor, 'decision', {
          enumerable: true,
          configurable: true,
          get() {
            accessorReads += 1;
            return proof.decision;
          },
        });
        return accessor;
      },
      (proof) =>
        new Proxy(proof, {
          ownKeys() {
            throw new Error('hostile proof proxy');
          },
        }),
      (proof) => ({ ...proof, unexpectedLiveState: true }),
    ];

    for (const makeProof of proofFactories) {
      let hostVerifications = 0;
      const core: SemWitnessCore = {
        ...base,
        async simulate(segment, candidate) {
          const simulation = await base.simulate(segment, candidate);
          return {
            ...simulation,
            proof: makeProof(simulation.proof) as ProofEnvelope,
          };
        },
        async verify(proof, segment, encoded, candidate) {
          hostVerifications += 1;
          return base.verify(proof, segment, encoded, candidate);
        },
      };
      const result = await createVerifiedTextRequestPreparer(
        core,
        policy,
        promotion,
      ).prepare(request);

      expect(result.content).toBe(request.content);
      expect(result.applied).toBe(false);
      expect(result.reasons).toEqual(['PROOF_VERIFICATION_FAILED']);
      expect(result.proof).toBeUndefined();
      expect(hostVerifications).toBe(0);
    }
    expect(accessorReads).toBe(0);
  });

  it('detects retrieved candidate length corruption', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const core: SemWitnessCore = {
      ...base,
      async retrieve() {
        return new TextEncoder().encode('tampered-candidate');
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['RETRIEVED_CONTENT_MISMATCH']);
  });

  it('detects retrieved candidate digest corruption at the same byte length', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const core: SemWitnessCore = {
      ...base,
      async retrieve(reference, candidate) {
        const bytes = await base.retrieve(reference, candidate);
        const corrupted = new Uint8Array(bytes);
        corrupted[0] = (corrupted[0] ?? 0) ^ 0x01;
        return corrupted;
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['RETRIEVED_CONTENT_MISMATCH']);
    expect(result.proof?.encoded.byteLength).toBeGreaterThan(0);
  });

  it('normalizes retrieval and proof-verification failures', async () => {
    const first = await fixture();
    const retrievalFailure: SemWitnessCore = {
      ...first.core,
      async retrieve() {
        throw new Error('storage unavailable');
      },
    };
    const retrievalResult = await createVerifiedTextRequestPreparer(
      retrievalFailure,
      first.policy,
      first.promotion,
    ).prepare(first.request);
    expect(retrievalResult.content).toBe(first.request.content);
    expect(retrievalResult.reasons).toEqual(['RETRIEVAL_FAILED']);

    const second = await fixture();
    const verificationFailure: SemWitnessCore = {
      ...second.core,
      async verify() {
        return { verified: false, reasons: ['PROOF_DIGEST_MISMATCH'] };
      },
    };
    const verificationResult = await createVerifiedTextRequestPreparer(
      verificationFailure,
      second.policy,
      second.promotion,
    ).prepare(second.request);
    expect(verificationResult.content).toBe(second.request.content);
    expect(verificationResult.reasons).toEqual(['PROOF_VERIFICATION_FAILED']);
  });

  it('isolates private proof and CAS bytes from a verifier mutating both copies', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    let verifierMutated = false;
    const core: SemWitnessCore = {
      ...base,
      async verify(proof, segment, encoded, candidate) {
        const verification = await base.verify(
          proof,
          segment,
          encoded,
          candidate,
        );
        const mutableProof = proof as DeepMutable<ProofEnvelope>;
        mutableProof.decision.status = 'bypassed';
        mutableProof.decision.reasons.push('FALLBACK_ORIGINAL');
        mutableProof.proofDigest = sha256('mutated-by-host-verifier');
        encoded.bytes[0] = (encoded.bytes[0] ?? 0) ^ 0x01;
        verifierMutated = true;
        return verification;
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(verifierMutated).toBe(true);
    expect(result.applied).toBe(true);
    expect(JSON.parse(result.content)).toEqual(JSON.parse(request.content));
    expect(result.proof?.decision).toEqual({
      status: 'applied',
      reasons: ['APPLIED'],
    });
    expect(result.proof?.proofDigest).toBe(
      recomputeProofDigest(result.proof as ProofEnvelope),
    );
    expect(Object.isFrozen(result.proof)).toBe(true);
    expect(Object.isFrozen(result.proof?.decision)).toBe(true);
    expect(Object.isFrozen(result.proof?.decision.reasons)).toBe(true);
    expect(Object.isFrozen(result.proof?.tokenEvidence)).toBe(true);
    expect(Object.isFrozen(result.proof?.tokenEvidence[0])).toBe(true);
    expect(sha256(new TextEncoder().encode(result.content))).toBe(
      result.proof?.encoded.sha256,
    );
  });

  it('reverifies and rejects a tampered proof digest', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const core: SemWitnessCore = {
      ...base,
      async simulate(segment, candidate) {
        const simulation = await base.simulate(segment, candidate);
        return {
          ...simulation,
          proof: {
            ...simulation.proof,
            proofDigest: sha256('tampered-proof-envelope'),
          },
        };
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['PROOF_VERIFICATION_FAILED']);
  });

  it('requires fatal UTF-8 decoding after digest and proof verification', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const actual = await base.simulate(
      {
        schema: 'semwitness.dev/segment/v1alpha1',
        id: request.id,
        role: request.role,
        roleOrigin: 'host',
        kind: request.kind,
        trust: request.trust,
        mediaType: request.mediaType,
        content: new TextEncoder().encode(request.content),
        equivalence: request.equivalence,
        anchors: [],
      },
      policy,
    );
    const invalidUtf8 = new Uint8Array([0xff]);
    const { proofDigest: _proofDigest, ...unsigned } = actual.proof;
    const proof = finalizeProof({
      ...unsigned,
      encoded: {
        ...unsigned.encoded,
        sha256: sha256(invalidUtf8),
        byteLength: invalidUtf8.byteLength,
        stored: true,
      },
    });
    const core: SemWitnessCore = {
      ...base,
      async simulate() {
        return {
          ...actual,
          applied: true,
          selectedCodec: proof.codec.id,
          effectiveReference: proof.encoded.sha256,
          projectedReference: proof.encoded.sha256,
          projectedStored: true,
          proof,
        };
      },
      async retrieve() {
        return invalidUtf8;
      },
      async verify() {
        return { verified: true, reasons: [] };
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result.content).toBe(request.content);
    expect(result.applied).toBe(false);
    expect(result.reasons).toEqual(['INVALID_UTF8']);
  });

  it('catches malformed core results as bounded runtime failures', async () => {
    const { core: base, policy, promotion, request } = await fixture();
    const core: SemWitnessCore = {
      ...base,
      async simulate() {
        return null as never;
      },
    };
    const result = await createVerifiedTextRequestPreparer(
      core,
      policy,
      promotion,
    ).prepare(request);

    expect(result).toMatchObject({
      content: request.content,
      applied: false,
      selectedCodec: 'identity',
      reasons: ['RUNTIME_ERROR'],
    });
    expect(result.reasons.every(isHostReasonCode)).toBe(true);
  });
});
