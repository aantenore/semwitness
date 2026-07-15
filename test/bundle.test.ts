import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSemWitness,
  type SemWitnessCore,
} from '../src/composition-root.js';
import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { hashCanonical, sha256 } from '../src/domain/hash.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import {
  recomputeProofDigest,
  type ProofEnvelope,
} from '../src/domain/proof.js';
import { createSegment, type Segment } from '../src/domain/types.js';
import {
  createSimulationBundle,
  parseSimulationBundle,
  verifySimulationBundle,
  type SimulationBundle,
} from '../src/entrypoints/bundle.js';
import { DeterministicByteTokenizer } from './helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

interface BundleFixture {
  readonly core: SemWitnessCore;
  readonly segment: Segment;
  readonly bundle: SimulationBundle;
  readonly source: string;
  readonly sourceSentinel: string;
  readonly projectedSentinel: string;
  readonly projected: Uint8Array;
}

const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-bundle-test-'));
  temporaryRoots.add(root);
  return root;
}

async function bundleFixture(): Promise<BundleFixture> {
  const sourceSentinel = 'SOURCE_SENTINEL_9d9d8dadf63a';
  const projectedSentinel = 'PROJECTED_SENTINEL_341726e48e0b';
  const records = Array.from(
    { length: 48 },
    (_, index) =>
      `    { "index": ${index}, "status": "ready", "marker": "${projectedSentinel}" }`,
  ).join(',\n');
  const source = `{
  "sourceMarker": "${sourceSentinel}",
  "records": [
${records}
  ]
}`;
  const segment = createSegment({
    id: 'bundle-privacy-case',
    role: 'tool',
    kind: 'json-data',
    trust: 'workspace-trusted',
    content: source,
  });
  const core = createSemWitness({
    storeRoot: await temporaryRoot(),
    policy: DEFAULT_POLICY,
    tokenizer: new DeterministicByteTokenizer(),
  });
  const simulation = await core.simulate(segment, DEFAULT_POLICY);
  expect(simulation.selectedCodec).toBe('json-jcs');
  expect(simulation.projectedStored).toBe(true);
  const projected = await core.retrieve(
    simulation.proof.encoded.sha256,
    DEFAULT_POLICY,
  );
  return {
    core,
    segment,
    bundle: createSimulationBundle({
      segment,
      policy: DEFAULT_POLICY,
      simulation,
    }),
    source,
    sourceSentinel,
    projectedSentinel,
    projected,
  };
}

function serialize(bundle: SimulationBundle): string {
  return canonicalJson(toJsonValue(bundle));
}

function mutableBundle(
  bundle: SimulationBundle,
): DeepMutable<SimulationBundle> {
  return structuredClone(bundle) as DeepMutable<SimulationBundle>;
}

function resealBundle(bundle: DeepMutable<SimulationBundle>): void {
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  bundle.bundleDigest = hashCanonical(toJsonValue(unsigned));
}

function resealProof(proof: DeepMutable<ProofEnvelope>): void {
  proof.proofDigest = recomputeProofDigest(proof);
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('content-free simulation bundles', () => {
  it('contains only metadata and CAS evidence, then round-trips through CAS verification', async () => {
    const fixture = await bundleFixture();
    const encodedText = new TextDecoder().decode(fixture.projected);
    expect(encodedText).toContain(fixture.sourceSentinel);
    expect(encodedText).toContain(fixture.projectedSentinel);
    expect(encodedText).not.toBe(fixture.source);

    expect(Object.keys(fixture.bundle).sort()).toEqual([
      'bundleDigest',
      'input',
      'policy',
      'proof',
      'schema',
    ]);
    const wire = serialize(fixture.bundle);
    expect(wire).not.toContain(fixture.sourceSentinel);
    expect(wire).not.toContain(fixture.projectedSentinel);
    expect(wire).not.toContain(Buffer.from(fixture.source).toString('base64'));
    expect(wire).not.toContain(
      Buffer.from(fixture.projected).toString('base64'),
    );
    expect(wire).not.toContain('contentBase64');

    const parsed = parseSimulationBundle(wire);
    await expect(verifySimulationBundle(fixture.core, parsed)).resolves.toEqual(
      { verified: true, reasons: [] },
    );
  });

  it('rejects an altered outer bundle digest', async () => {
    const fixture = await bundleFixture();
    const tampered = mutableBundle(fixture.bundle);
    tampered.bundleDigest = sha256('attacker-controlled-bundle');

    expect(() => parseSimulationBundle(serialize(tampered))).toThrow();
  });

  it('detects proof evidence tampering even after both digests are recomputed', async () => {
    const fixture = await bundleFixture();
    const tampered = mutableBundle(fixture.bundle);
    tampered.proof.tokenEvidence[0]!.encodedTokens += 1;
    resealProof(tampered.proof);
    resealBundle(tampered);

    const verification = await verifySimulationBundle(
      fixture.core,
      parseSimulationBundle(serialize(tampered)),
    );
    expect(verification.verified).toBe(false);
    expect(verification.reasons).toContain('TOKENIZER_ERROR');
  });

  it('detects policy tampering when the attacker recomputes the bundle digest', async () => {
    const fixture = await bundleFixture();
    const tampered = mutableBundle(fixture.bundle);
    tampered.policy.selection.minTokenSavings += 1;
    resealBundle(tampered);

    const verification = await verifySimulationBundle(
      fixture.core,
      parseSimulationBundle(serialize(tampered)),
    );
    expect(verification.verified).toBe(false);
    expect(verification.reasons).toContain('POLICY_DIGEST_MISMATCH');
  });

  it('fails closed when a resealed proof redirects the projected CAS reference', async () => {
    const fixture = await bundleFixture();
    const tampered = mutableBundle(fixture.bundle);
    tampered.proof.encoded.sha256 = sha256('missing-projected-object');
    resealProof(tampered.proof);
    resealBundle(tampered);

    await expect(
      verifySimulationBundle(
        fixture.core,
        parseSimulationBundle(serialize(tampered)),
      ),
    ).rejects.toMatchObject({ code: 'CAS_MISS' });
  });
});
