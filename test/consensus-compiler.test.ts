import { describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  ConsensusIntentCompiler,
  type ConsensusIntentCompilerPolicy,
} from '../src/intent/index.js';
import type {
  IntentCompilerResult,
  IntentNormalizerManifest,
  IntentProposalCompiler,
} from '../src/intent/normalizer-types.js';
import type {
  CandidateEvidence,
  OntologyBinding,
} from '../src/intent/types.js';

const ontology: OntologyBinding = {
  id: 'knowledge-intents',
  version: '1.0.0',
  digest: sha256('knowledge-intents-v1'),
};
const policy: ConsensusIntentCompilerPolicy = {
  strategy: 'all-agree',
  maxCandidateEvidence: 4,
};

function manifest(
  id: string,
  memberOntology: OntologyBinding = ontology,
): IntentNormalizerManifest {
  return {
    normalizer: {
      id,
      version: '1.0.0',
      artifactDigest: sha256(`${id}-artifact`),
      configDigest: sha256(`${id}-config`),
    },
    ontology: memberOntology,
  };
}

function member(
  id: string,
  compile: IntentProposalCompiler['compile'],
  memberOntology: OntologyBinding = ontology,
): IntentProposalCompiler {
  return { manifest: manifest(id, memberOntology), compile };
}

function fixedMember(
  id: string,
  result: IntentCompilerResult,
): IntentProposalCompiler {
  return member(id, () => result);
}

function proposed(
  operationId: string,
  confidencePpm: number,
  options: {
    readonly ambiguous?: boolean;
    readonly candidateEvidence?: readonly CandidateEvidence[];
  } = {},
): IntentCompilerResult {
  return {
    status: 'proposed',
    operationId,
    confidencePpm,
    ambiguous: options.ambiguous ?? false,
    ...(options.candidateEvidence === undefined
      ? {}
      : { candidateEvidence: options.candidateEvidence }),
  };
}

function evidence(providerId: string, scorePpm: number): CandidateEvidence {
  return {
    kind: 'embedding',
    providerId,
    evidenceDigest: sha256(`${providerId}-${scorePpm}`),
    scorePpm,
    authoritative: false,
  };
}

describe('ConsensusIntentCompiler', () => {
  it('requires all members to agree and returns minimum confidence with deterministic evidence', async () => {
    const common = evidence('shared-provider', 800_000);
    const alpha = fixedMember(
      'alpha-compiler',
      proposed('explain-redis', 910_000, {
        candidateEvidence: [evidence('z-provider', 700_000), common],
      }),
    );
    const beta = fixedMember(
      'beta-compiler',
      proposed('explain-redis', 730_000, {
        candidateEvidence: [common, evidence('a-provider', 900_000)],
      }),
    );
    const compiler = new ConsensusIntentCompiler({
      members: [alpha, beta],
      policy,
    });
    const reordered = new ConsensusIntentCompiler({
      members: [beta, alpha],
      policy,
    });

    expect(reordered.manifest.normalizer.configDigest).toBe(
      compiler.manifest.normalizer.configDigest,
    );
    expect(
      new ConsensusIntentCompiler({
        members: [alpha, beta],
        policy: { ...policy, maxCandidateEvidence: 3 },
      }).manifest.normalizer.configDigest,
    ).not.toBe(compiler.manifest.normalizer.configDigest);
    expect(
      new ConsensusIntentCompiler({
        members: [
          alpha,
          fixedMember('gamma-compiler', proposed('explain-redis', 730_000)),
        ],
        policy,
      }).manifest.normalizer.configDigest,
    ).not.toBe(compiler.manifest.normalizer.configDigest);

    const result = await compiler.compile({
      source: 'Spiegami Redis',
      locale: 'it-IT',
    });
    const reorderedResult = await reordered.compile({
      source: 'Spiegami Redis',
      locale: 'it-IT',
    });
    expect(result).toEqual({
      status: 'proposed',
      operationId: 'explain-redis',
      confidencePpm: 730_000,
      ambiguous: false,
      candidateEvidence: [
        evidence('a-provider', 900_000),
        common,
        evidence('z-provider', 700_000),
      ],
    });
    expect(reorderedResult).toEqual(result);
    expect(Object.isFrozen(compiler)).toBe(true);
    expect(Object.isFrozen(compiler.manifest)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (
      result.status !== 'proposed' ||
      result.candidateEvidence === undefined
    ) {
      return;
    }
    expect(Object.isFrozen(result.candidateEvidence)).toBe(true);
    expect(Object.isFrozen(result.candidateEvidence[0])).toBe(true);
    expect(result).not.toHaveProperty('claim');
    expect(result).not.toHaveProperty('witness');
  });

  it('fails closed on bypass, ambiguity, disagreement, exceptions and malformed output', async () => {
    const agreed = fixedMember(
      'agreed-compiler',
      proposed('explain-redis', 900_000),
    );

    const noMatch = new ConsensusIntentCompiler({
      members: [
        agreed,
        fixedMember('no-match-compiler', {
          status: 'bypass',
          reason: 'INTENT_NO_MATCH',
        }),
      ],
      policy,
    });
    await expect(
      noMatch.compile({ source: 'unknown', locale: 'it-IT' }),
    ).resolves.toEqual({ status: 'bypass', reason: 'INTENT_AMBIGUOUS' });

    const unanimousNoMatch = new ConsensusIntentCompiler({
      members: [
        fixedMember('no-match-alpha', {
          status: 'bypass',
          reason: 'INTENT_NO_MATCH',
        }),
        fixedMember('no-match-beta', {
          status: 'bypass',
          reason: 'INTENT_NO_MATCH',
        }),
      ],
      policy,
    });
    await expect(
      unanimousNoMatch.compile({ source: 'unknown', locale: 'it-IT' }),
    ).resolves.toEqual({ status: 'bypass', reason: 'INTENT_NO_MATCH' });

    const ambiguous = new ConsensusIntentCompiler({
      members: [
        agreed,
        fixedMember(
          'ambiguous-compiler',
          proposed('explain-redis', 900_000, { ambiguous: true }),
        ),
      ],
      policy,
    });
    await expect(
      ambiguous.compile({ source: 'ambiguous', locale: 'it-IT' }),
    ).resolves.toEqual({ status: 'bypass', reason: 'INTENT_AMBIGUOUS' });

    const disagreement = new ConsensusIntentCompiler({
      members: [
        agreed,
        fixedMember(
          'other-operation-compiler',
          proposed('disable-redis', 900_000),
        ),
      ],
      policy,
    });
    await expect(
      disagreement.compile({ source: 'conflict', locale: 'it-IT' }),
    ).resolves.toEqual({ status: 'bypass', reason: 'INTENT_AMBIGUOUS' });

    const throwing = new ConsensusIntentCompiler({
      members: [
        agreed,
        member('throwing-compiler', () => {
          throw new Error('untrusted adapter detail');
        }),
      ],
      policy,
    });
    await expect(
      throwing.compile({ source: 'secret source', locale: 'it-IT' }),
    ).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });

    const malformed = new ConsensusIntentCompiler({
      members: [
        agreed,
        member(
          'malformed-compiler',
          () =>
            ({
              ...proposed('explain-redis', 900_000),
              unauthorized: true,
            }) as unknown as IntentCompilerResult,
        ),
      ],
      policy,
    });
    await expect(
      malformed.compile({ source: 'malformed', locale: 'it-IT' }),
    ).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });
  });

  it('never invokes member or result accessors and snapshots mutable boundaries', async () => {
    let manifestGetterInvoked = false;
    const accessorMember = Object.defineProperties(
      {
        compile: () => proposed('explain-redis', 900_000),
      },
      {
        manifest: {
          enumerable: true,
          get() {
            manifestGetterInvoked = true;
            return manifest('accessor-compiler');
          },
        },
      },
    ) as unknown as IntentProposalCompiler;
    expect(
      () =>
        new ConsensusIntentCompiler({
          members: [
            accessorMember,
            fixedMember('safe-compiler', proposed('explain-redis', 900_000)),
          ],
          policy,
        }),
    ).toThrow(/member is invalid/u);
    expect(manifestGetterInvoked).toBe(false);

    let memberElementGetterInvoked = false;
    const memberArray = [
      fixedMember('array-alpha', proposed('explain-redis', 900_000)),
      fixedMember('array-beta', proposed('explain-redis', 900_000)),
    ];
    Object.defineProperty(memberArray, '0', {
      enumerable: true,
      get() {
        memberElementGetterInvoked = true;
        return fixedMember(
          'array-accessor',
          proposed('explain-redis', 900_000),
        );
      },
    });
    expect(
      () => new ConsensusIntentCompiler({ members: memberArray, policy }),
    ).toThrow(/two to eight/u);
    expect(memberElementGetterInvoked).toBe(false);

    let resultGetterInvoked = false;
    const accessorResult = Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        resultGetterInvoked = true;
        return 'proposed';
      },
    }) as unknown as IntentCompilerResult;
    const accessorOutputCompiler = new ConsensusIntentCompiler({
      members: [
        fixedMember('safe-output-compiler', proposed('explain-redis', 900_000)),
        fixedMember('accessor-output-compiler', accessorResult),
      ],
      policy,
    });
    await expect(
      accessorOutputCompiler.compile({ source: 'accessor', locale: 'it-IT' }),
    ).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });
    expect(resultGetterInvoked).toBe(false);

    const mutableEvidence = evidence('mutable-provider', 810_000) as {
      kind: 'embedding';
      providerId: string;
      evidenceDigest: ReturnType<typeof sha256>;
      scorePpm: number;
      authoritative: false;
    };
    const mutableOutput = proposed('explain-redis', 820_000, {
      candidateEvidence: [mutableEvidence],
    }) as {
      status: 'proposed';
      operationId: string;
      confidencePpm: number;
      ambiguous: boolean;
      candidateEvidence: CandidateEvidence[];
    };
    const mutableManifest = manifest('mutable-compiler') as {
      normalizer: {
        id: string;
        version: string;
        artifactDigest: ReturnType<typeof sha256>;
        configDigest: ReturnType<typeof sha256>;
      };
      ontology: OntologyBinding;
    };
    const mutableMember: {
      manifest: IntentNormalizerManifest;
      compile: IntentProposalCompiler['compile'];
    } = {
      manifest: mutableManifest,
      compile: () => mutableOutput,
    };
    const members: IntentProposalCompiler[] = [
      mutableMember,
      fixedMember('stable-compiler', proposed('explain-redis', 830_000)),
    ];
    const snapshotted = new ConsensusIntentCompiler({ members, policy });
    const manifestDigest = snapshotted.manifest.normalizer.configDigest;
    mutableManifest.normalizer.configDigest = sha256('mutated-config');
    mutableMember.compile = () => proposed('disable-redis', 1_000_000);
    members[0] = fixedMember(
      'replacement-compiler',
      proposed('disable-redis', 1_000_000),
    );

    const result = await snapshotted.compile({
      source: 'snapshot',
      locale: 'it-IT',
    });
    mutableEvidence.scorePpm = 1;
    mutableOutput.operationId = 'disable-redis';
    expect(snapshotted.manifest.normalizer.configDigest).toBe(manifestDigest);
    expect(result).toMatchObject({
      status: 'proposed',
      operationId: 'explain-redis',
      confidencePpm: 820_000,
      candidateEvidence: [
        { providerId: 'mutable-provider', scorePpm: 810_000 },
      ],
    });
  });

  it('enforces member, ontology and combined-evidence bounds', async () => {
    const alpha = fixedMember(
      'alpha-bounded',
      proposed('explain-redis', 900_000, {
        candidateEvidence: [evidence('alpha-evidence', 800_000)],
      }),
    );
    expect(
      () => new ConsensusIntentCompiler({ members: [alpha], policy }),
    ).toThrow(/two to eight/u);
    expect(
      () =>
        new ConsensusIntentCompiler({
          members: [alpha, alpha],
          policy,
        }),
    ).toThrow(/distinct manifests/u);
    const eightMembers = Array.from({ length: 8 }, (_, index) =>
      fixedMember(
        `bounded-member-${String(index)}`,
        proposed('explain-redis', 900_000),
      ),
    );
    expect(
      () => new ConsensusIntentCompiler({ members: eightMembers, policy }),
    ).not.toThrow();
    expect(
      () =>
        new ConsensusIntentCompiler({
          members: [
            ...eightMembers,
            fixedMember(
              'bounded-member-extra',
              proposed('explain-redis', 900_000),
            ),
          ],
          policy,
        }),
    ).toThrow(/two to eight/u);
    expect(
      () =>
        new ConsensusIntentCompiler({
          members: [
            alpha,
            member('other-ontology', () => proposed('explain-redis', 900_000), {
              ...ontology,
              digest: sha256('other-ontology'),
            }),
          ],
          policy,
        }),
    ).toThrow(/share an ontology/u);

    const bounded = new ConsensusIntentCompiler({
      members: [
        alpha,
        fixedMember(
          'beta-bounded',
          proposed('explain-redis', 900_000, {
            candidateEvidence: [evidence('beta-evidence', 800_000)],
          }),
        ),
      ],
      policy: { strategy: 'all-agree', maxCandidateEvidence: 1 },
    });
    await expect(
      bounded.compile({ source: 'bounded', locale: 'it-IT' }),
    ).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });
  });

  it('does not invoke members when pre-aborted and returns promptly on mid-flight abort', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const first = vi.fn<IntentProposalCompiler['compile']>(() =>
      proposed('explain-redis', 900_000),
    );
    const second = vi.fn<IntentProposalCompiler['compile']>(() =>
      proposed('explain-redis', 900_000),
    );
    const compiler = new ConsensusIntentCompiler({
      members: [member('abort-alpha', first), member('abort-beta', second)],
      policy,
    });
    await expect(
      compiler.compile({
        source: 'pre-aborted',
        locale: 'it-IT',
        signal: preAborted.signal,
      }),
    ).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    const controller = new AbortController();
    const requests: unknown[] = [];
    let startedCount = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging = (id: string) =>
      member(id, (request) => {
        requests.push(request);
        startedCount += 1;
        if (startedCount === 2) markStarted();
        return new Promise<IntentCompilerResult>(() => undefined);
      });
    const midFlight = new ConsensusIntentCompiler({
      members: [hanging('hanging-alpha'), hanging('hanging-beta')],
      policy,
    });
    const pending = midFlight.compile({
      source: 'mid-flight',
      locale: 'it-IT',
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).resolves.toEqual({
      status: 'bypass',
      reason: 'INTENT_COMPILER_FAILURE',
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => Object.isFrozen(request))).toBe(true);
    expect(
      requests.every(
        (request) =>
          (request as { readonly signal: AbortSignal }).signal ===
          controller.signal,
      ),
    ).toBe(true);
  });
});
