import { z } from 'zod';

import { immutableJson, toJsonValue } from '../domain/canonical-json.js';
import { hashCanonical } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { digestIntent } from './canonical.js';
import { IntentWitnessError } from './types.js';
import { intentIRSchema } from './schemas.js';
import {
  INTENT_EVALUATION_FIXTURE_SCHEMA,
  INTENT_EVALUATION_PHENOMENA,
  INTENT_OPERATION_REGISTRY_SCHEMA,
  type IntentEvaluationCase,
  type IntentEvaluationComparison,
  type IntentEvaluationFixture,
  type IntentOperationRegistryDocument,
} from './normalizer-types.js';
import {
  canonicalIntentAliasText,
  canonicalIntentLocale,
} from './intent-lexical.js';

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_EVALUATION_FIXTURE_BYTES = 96 * 1024 * 1024;
const MAX_CASE_LINE_BYTES = 256 * 1024;
const MAX_CASES = 50_000;
const parsedEvaluationFixtures = new WeakSet<object>();
const safeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const locale = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/u);
const ppm = z.number().int().min(0).max(1_000_000);
const ontology = intentIRSchema.shape.ontology;

const registrySchema = z
  .object({
    schema: z.literal(INTENT_OPERATION_REGISTRY_SCHEMA),
    ontology,
    minimumConfidencePpm: ppm,
    operations: z
      .array(
        z
          .object({
            id: safeId,
            aliases: z
              .array(
                z
                  .object({
                    locale,
                    text: z.string().min(1).max(4_096),
                  })
                  .strict(),
              )
              .min(1)
              .max(256),
            intent: intentIRSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1_024),
  })
  .strict();

const evaluationCaseSchema = z
  .object({
    schema: z.literal(INTENT_EVALUATION_FIXTURE_SCHEMA),
    kind: z.literal('case'),
    id: safeId,
    familyId: safeId,
    split: z.enum(['conformance', 'development', 'held-out']),
    difficulty: z.enum(['simple', 'medium', 'complex', 'adversarial']),
    phenomena: z
      .array(z.enum(INTENT_EVALUATION_PHENOMENA))
      .min(1)
      .max(INTENT_EVALUATION_PHENOMENA.length),
    input: z.object({ source: z.string().min(1).max(16_384), locale }).strict(),
    expect: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('intent'), intent: intentIRSchema }).strict(),
      z.object({ kind: z.literal('bypass') }).strict(),
    ]),
  })
  .strict();

const evaluationComparisonSchema = z
  .object({
    schema: z.literal(INTENT_EVALUATION_FIXTURE_SCHEMA),
    kind: z.literal('comparison'),
    id: safeId,
    split: z.enum(['conformance', 'development', 'held-out']),
    leftCaseId: safeId,
    rightCaseId: safeId,
    relation: z.enum(['equivalent', 'distinct']),
  })
  .strict();

const evaluationRecordSchema = z.discriminatedUnion('kind', [
  evaluationCaseSchema,
  evaluationComparisonSchema,
]);

export function parseIntentOperationRegistry(
  input: string,
): IntentOperationRegistryDocument {
  const value = boundedDocument(input, MAX_REGISTRY_BYTES);
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) {
    throw malformed('Intent operation registry failed strict validation');
  }

  const operationIds = new Set<string>();
  const aliases = new Set<string>();
  for (const operation of parsed.data.operations) {
    if (operationIds.has(operation.id)) {
      throw malformed('Intent operation registry contains a duplicate id');
    }
    operationIds.add(operation.id);
    if (!sameOntology(parsed.data.ontology, operation.intent.ontology)) {
      throw malformed('Operation intent does not match registry ontology');
    }
    for (const alias of operation.aliases) {
      const text = canonicalIntentAliasText(alias.text);
      if (text.length === 0) {
        throw malformed('Intent alias is empty after lexical normalization');
      }
      const key = `${canonicalIntentLocale(alias.locale)}\0${text}`;
      if (aliases.has(key)) {
        throw malformed(
          'Intent operation registry contains an ambiguous normalized alias',
        );
      }
      aliases.add(key);
    }
  }

  return parsed.data as IntentOperationRegistryDocument;
}

export function parseIntentEvaluationJsonl(
  source: string,
  maximumCases = MAX_CASES,
): IntentEvaluationFixture {
  if (typeof source !== 'string') {
    throw malformed('Intent evaluation fixture must be a string');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_EVALUATION_FIXTURE_BYTES) {
    throw new IntentWitnessError(
      'INTENT_DOCUMENT_LIMIT',
      'Intent evaluation fixture exceeds the byte limit',
    );
  }
  if (
    !Number.isSafeInteger(maximumCases) ||
    maximumCases < 1 ||
    maximumCases > MAX_CASES
  ) {
    throw malformed('Intent evaluation case limit is invalid');
  }
  const cases: IntentEvaluationCase[] = [];
  const comparisons: IntentEvaluationComparison[] = [];
  const ids = new Set<string>();
  let lineStart = 0;
  let lineNumber = 0;

  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor < source.length && source.charCodeAt(cursor) !== 0x0a) continue;
    lineNumber += 1;
    let start = lineStart;
    let end = cursor;
    lineStart = cursor + 1;
    if (end > start && source.charCodeAt(end - 1) === 0x0d) end -= 1;
    while (start < end && isHorizontalWhitespace(source.charCodeAt(start))) {
      start += 1;
    }
    while (end > start && isHorizontalWhitespace(source.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (start === end) continue;
    if (cases.length >= maximumCases || comparisons.length >= maximumCases) {
      throw malformed('Intent evaluation fixture exceeds the case limit');
    }
    const line = source.slice(start, end);
    if (Buffer.byteLength(line, 'utf8') > MAX_CASE_LINE_BYTES) {
      throw malformed(`Intent evaluation line ${lineNumber} is too large`);
    }
    let value;
    try {
      value = parseStrictJson(line, {
        maxDepth: 24,
        maxItems: 10_000,
        maxStringCodeUnits: 16_384,
        maxNumberCodeUnits: 128,
      });
    } catch {
      throw malformed(
        `Intent evaluation line ${lineNumber} is not strict JSON`,
      );
    }
    const parsed = evaluationRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw malformed(
        `Intent evaluation line ${lineNumber} has an invalid schema`,
      );
    }
    if (ids.has(parsed.data.id)) {
      throw malformed('Intent evaluation fixture contains a duplicate id');
    }
    ids.add(parsed.data.id);
    if (parsed.data.kind === 'case') {
      const phenomena = [...new Set(parsed.data.phenomena)].sort(
        compareCodeUnits,
      );
      cases.push({ ...parsed.data, phenomena } as IntentEvaluationCase);
    } else {
      comparisons.push(parsed.data as IntentEvaluationComparison);
    }
  }
  if (cases.length === 0) {
    throw malformed('Intent evaluation fixture contains no cases');
  }
  validateEvaluationFixture(cases, comparisons);
  const canonicalCases = [...cases].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const canonicalComparisons = [...comparisons].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  const fixture = immutableJson(
    toJsonValue({
      corpusDigest: hashCanonical(
        toJsonValue({
          schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
          cases: canonicalCases,
          comparisons: canonicalComparisons,
        }),
      ),
      cases: canonicalCases,
      comparisons: canonicalComparisons,
    }),
  ) as unknown as IntentEvaluationFixture;
  parsedEvaluationFixtures.add(fixture);
  return fixture;
}

export function assertParsedIntentEvaluationFixture(
  fixture: IntentEvaluationFixture,
): void {
  if (
    fixture === null ||
    typeof fixture !== 'object' ||
    !parsedEvaluationFixtures.has(fixture) ||
    !Object.isFrozen(fixture)
  ) {
    throw malformed(
      'Intent evaluation fixture must come from the strict JSONL parser',
    );
  }
}

function validateEvaluationFixture(
  cases: readonly IntentEvaluationCase[],
  comparisons: readonly IntentEvaluationComparison[],
): void {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const familyContract = new Map<
    string,
    { readonly split: IntentEvaluationCase['split']; readonly digest: string }
  >();
  const intentFamilies = new Map<string, string>();
  const normalizedInputs = new Set<string>();
  for (const item of cases) {
    const digest =
      item.expect.kind === 'intent'
        ? digestIntent(item.expect.intent)
        : 'expected-bypass';
    const previous = familyContract.get(item.familyId);
    if (
      previous !== undefined &&
      (previous.split !== item.split || previous.digest !== digest)
    ) {
      throw malformed(
        'Intent evaluation family crosses a split or expected intent',
      );
    }
    familyContract.set(item.familyId, { split: item.split, digest });
    const inputKey = `${canonicalIntentLocale(item.input.locale)}\0${canonicalIntentAliasText(item.input.source)}`;
    if (normalizedInputs.has(inputKey)) {
      throw malformed(
        'Intent evaluation fixture contains a duplicate normalized input',
      );
    }
    normalizedInputs.add(inputKey);
    if (item.expect.kind === 'intent') {
      const knownFamily = intentFamilies.get(digest);
      if (knownFamily !== undefined && knownFamily !== item.familyId) {
        throw malformed(
          'Canonical expected intent is assigned to multiple families',
        );
      }
      intentFamilies.set(digest, item.familyId);
    }
  }

  const pairs = new Set<string>();
  for (const comparison of comparisons) {
    if (comparison.leftCaseId === comparison.rightCaseId) {
      throw malformed('Intent evaluation comparison cannot reference itself');
    }
    const left = byId.get(comparison.leftCaseId);
    const right = byId.get(comparison.rightCaseId);
    if (left === undefined || right === undefined) {
      throw malformed('Intent evaluation comparison has a dangling case id');
    }
    if (left.split !== comparison.split || right.split !== comparison.split) {
      throw malformed('Intent evaluation comparison crosses a split');
    }
    const pair = [left.id, right.id].sort(compareCodeUnits).join('\0');
    if (pairs.has(pair)) {
      throw malformed('Intent evaluation fixture contains a duplicate pair');
    }
    pairs.add(pair);
    if (left.expect.kind !== 'intent' || right.expect.kind !== 'intent') {
      throw malformed('Expected bypass cases cannot enter comparisons');
    }
    const same =
      digestIntent(left.expect.intent) === digestIntent(right.expect.intent);
    if (
      (comparison.relation === 'equivalent' && !same) ||
      (comparison.relation === 'distinct' && same)
    ) {
      throw malformed('Intent evaluation comparison contradicts ground truth');
    }
    if (
      (comparison.relation === 'equivalent' &&
        left.familyId !== right.familyId) ||
      (comparison.relation === 'distinct' && left.familyId === right.familyId)
    ) {
      throw malformed('Intent evaluation comparison contradicts family labels');
    }
  }
}

function boundedDocument(input: string, maximumBytes: number): unknown {
  if (typeof input !== 'string') {
    throw malformed('Intent document must be a string');
  }
  if (Buffer.byteLength(input, 'utf8') > maximumBytes) {
    throw new IntentWitnessError(
      'INTENT_DOCUMENT_LIMIT',
      'Intent document exceeds the byte limit',
    );
  }
  try {
    return parseStrictJson(input, {
      maxDepth: 24,
      maxItems: 100_000,
      maxStringCodeUnits: 16_384,
      maxNumberCodeUnits: 128,
    });
  } catch {
    throw malformed('Intent document is not strict bounded JSON');
  }
}

function sameOntology(
  left: IntentOperationRegistryDocument['ontology'],
  right: IntentOperationRegistryDocument['ontology'],
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function isHorizontalWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

function malformed(message: string): IntentWitnessError {
  return new IntentWitnessError('INTENT_MALFORMED', message);
}
