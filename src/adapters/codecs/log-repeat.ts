import { SemWitnessError } from '../../domain/errors.js';
import { sha256 } from '../../domain/hash.js';
import type {
  Codec,
  DecodeContext,
  EncodedCandidate,
} from '../../ports/codec.js';

const MARKER = '\u001eSWLR1:';
const MARKER_PAYLOAD_PATTERN = /^(\d{1,9}):([a-f0-9]{16});\n$/u;
const MAX_LOG_RECORDS = 100_000;
const textEncoder = new TextEncoder();
const LEGEND = new TextEncoder().encode(
  'SemWitness log notation: a line followed by RS SWLR1:<n>:<hash>; represents n additional exact repetitions.',
);

export class LogRepeatCodec implements Codec {
  readonly descriptor = {
    id: 'log-repeat',
    version: '1',
    deterministic: true,
    acceptedKinds: ['log'],
    equivalence: 'roundtrip-exact',
    decoderLegend: LEGEND,
  } as const;

  async encode(
    segment: Parameters<Codec['encode']>[0],
    context: Parameters<Codec['encode']>[1],
  ): Promise<EncodedCandidate> {
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(
        segment.content,
      );
    } catch (error) {
      throw new SemWitnessError(
        'FORMAT_UNSUPPORTED',
        'Log repeat codec requires UTF-8',
        error,
      );
    }
    if (source.includes(MARKER)) {
      throw new SemWitnessError(
        'FORMAT_UNSUPPORTED',
        'Log input collides with the codec marker',
      );
    }

    const output: string[] = [];
    let current: string | undefined;
    let count = 0;
    let recordCount = 0;
    const recordLimit = Math.min(
      MAX_LOG_RECORDS,
      context.policy.limits.maxItems,
    );
    const flush = () => {
      if (current === undefined) {
        return;
      }
      const record = current;
      const hasLineEnding = /(?:\r\n|\r|\n)$/u.test(record);
      output.push(record);
      if (count >= 3 && hasLineEnding) {
        const digest = sha256(textEncoder.encode(record)).slice(
          'sha256:'.length,
          'sha256:'.length + 16,
        );
        output.push(`${MARKER}${count - 1}:${digest};\n`);
      } else {
        for (let index = 1; index < count; index += 1) {
          output.push(record);
        }
      }
    };
    for (const record of iterateRecords(source)) {
      recordCount += 1;
      if (recordCount > recordLimit) {
        throw new SemWitnessError(
          'INPUT_TOO_LARGE',
          'Log input exceeds the record limit',
        );
      }
      if (record === current) {
        count += 1;
      } else {
        flush();
        current = record;
        count = 1;
      }
    }
    flush();

    return {
      bytes: textEncoder.encode(output.join('')),
    };
  }

  async decode(
    candidate: EncodedCandidate,
    context: DecodeContext,
  ): Promise<Uint8Array> {
    let encoded: string;
    try {
      encoded = new TextDecoder('utf-8', { fatal: true }).decode(
        candidate.bytes,
      );
    } catch (error) {
      throw new SemWitnessError(
        'FORMAT_UNSUPPORTED',
        'Log repeat payload is not UTF-8',
        error,
      );
    }

    if (
      !Number.isSafeInteger(context.maxOutputBytes) ||
      context.maxOutputBytes < 1 ||
      !Number.isSafeInteger(context.maxItems) ||
      context.maxItems < 1
    ) {
      throw new SemWitnessError('DECODE_LIMIT', 'Invalid log output limit');
    }

    let byteLength = 0;
    let recordCount = 0;
    const recordLimit = Math.min(MAX_LOG_RECORDS, context.maxItems);
    let previousBytes: Uint8Array | undefined;
    for (const record of iterateRecords(encoded)) {
      if (!record.startsWith(MARKER)) {
        previousBytes = textEncoder.encode(record);
        byteLength = boundedAdd(
          byteLength,
          previousBytes.byteLength,
          context.maxOutputBytes,
        );
        recordCount = boundedRecordAdd(recordCount, 1, recordLimit);
        continue;
      }
      const repetitions = parseMarker(record, previousBytes);
      recordCount = boundedRecordAdd(recordCount, repetitions, recordLimit);
      byteLength = boundedRepeatAdd(
        byteLength,
        previousBytes!.byteLength,
        repetitions,
        context.maxOutputBytes,
      );
    }

    let output: Uint8Array;
    try {
      output = new Uint8Array(byteLength);
    } catch (error) {
      throw new SemWitnessError(
        'DECODE_LIMIT',
        'Unable to allocate bounded log output',
        error,
      );
    }
    let offset = 0;
    previousBytes = undefined;
    for (const record of iterateRecords(encoded)) {
      if (!record.startsWith(MARKER)) {
        previousBytes = textEncoder.encode(record);
        output.set(previousBytes, offset);
        offset += previousBytes.byteLength;
        continue;
      }
      const repetitions = parseMarker(record, previousBytes);
      offset = repeatInto(output, offset, previousBytes!, repetitions);
    }
    return output;
  }
}

function* iterateRecords(source: string): Generator<string> {
  let start = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\r') {
      if (source[cursor + 1] === '\n') {
        cursor += 1;
      }
      yield source.slice(start, cursor + 1);
      start = cursor + 1;
    } else if (character === '\n') {
      yield source.slice(start, cursor + 1);
      start = cursor + 1;
    }
  }
  if (start < source.length) {
    yield source.slice(start);
  }
}

function parseMarker(
  record: string,
  previousBytes: Uint8Array | undefined,
): number {
  const match = record.startsWith(MARKER)
    ? MARKER_PAYLOAD_PATTERN.exec(record.slice(MARKER.length))
    : null;
  if (match === null || previousBytes === undefined) {
    throw new SemWitnessError(
      'FORMAT_UNSUPPORTED',
      'Malformed log repeat marker',
    );
  }
  const repetitions = Number(match[1]);
  const actualDigest = sha256(previousBytes).slice(
    'sha256:'.length,
    'sha256:'.length + 16,
  );
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    match[2] !== actualDigest
  ) {
    throw new SemWitnessError(
      'DECODE_LIMIT',
      'Unsafe or corrupt log repeat marker',
    );
  }
  return repetitions;
}

function boundedAdd(current: number, added: number, limit: number): number {
  if (added > limit - current) {
    throw new SemWitnessError('DECODE_LIMIT', 'Log output exceeds byte limit');
  }
  return current + added;
}

function boundedRepeatAdd(
  current: number,
  unitBytes: number,
  repetitions: number,
  limit: number,
): number {
  if (
    unitBytes === 0 ||
    repetitions > Math.floor((limit - current) / unitBytes)
  ) {
    throw new SemWitnessError(
      'DECODE_LIMIT',
      'Log repetition exceeds byte limit',
    );
  }
  return current + unitBytes * repetitions;
}

function boundedRecordAdd(
  current: number,
  added: number,
  limit: number,
): number {
  if (added > limit - current) {
    throw new SemWitnessError(
      'DECODE_LIMIT',
      'Log output exceeds the record limit',
    );
  }
  return current + added;
}

function repeatInto(
  output: Uint8Array,
  offset: number,
  unit: Uint8Array,
  repetitions: number,
): number {
  const expandedBytes = unit.byteLength * repetitions;
  output.set(unit, offset);
  let filled = unit.byteLength;
  while (filled < expandedBytes) {
    const copied = Math.min(filled, expandedBytes - filled);
    output.copyWithin(offset + filled, offset, offset + copied);
    filled += copied;
  }
  return offset + expandedBytes;
}
