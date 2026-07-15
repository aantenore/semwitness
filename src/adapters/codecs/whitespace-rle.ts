import { SemWitnessError } from '../../domain/errors.js';
import { Buffer } from 'node:buffer';
import type {
  Codec,
  DecodeContext,
  EncodedCandidate,
} from '../../ports/codec.js';

const MARKER = '~SWW1~';
const MAX_WHITESPACE_OPERATIONS = 100_000;
const LEGEND = new TextEncoder().encode(
  'SemWitness whitespace notation: ~SWW1~S<n>; means n spaces, ~SWW1~T<n>; means n tabs.',
);

export class WhitespaceRleCodec implements Codec {
  readonly descriptor = {
    id: 'whitespace-rle',
    version: '1',
    deterministic: true,
    acceptedKinds: ['prose', 'tool-result', 'log'],
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
        'Whitespace RLE requires UTF-8',
        error,
      );
    }

    const chunks: string[] = [];
    let rawStart = 0;
    let cursor = 0;
    let operations = 0;
    const operationLimit = Math.min(
      MAX_WHITESPACE_OPERATIONS,
      context.policy.limits.maxItems,
    );
    const emit = (end: number, marker: string): void => {
      if (end > rawStart) {
        chunks.push(source.slice(rawStart, end));
      }
      operations += 1;
      if (operations > operationLimit) {
        throw new SemWitnessError(
          'INPUT_TOO_LARGE',
          'Whitespace input exceeds the operation limit',
        );
      }
      chunks.push(marker);
    };
    while (cursor < source.length) {
      if (source.startsWith(MARKER, cursor)) {
        emit(cursor, `${MARKER}E;`);
        cursor += MARKER.length;
        rawStart = cursor;
        continue;
      }
      const character = source[cursor];
      if (character !== ' ' && character !== '\t') {
        cursor += 1;
        continue;
      }
      let end = cursor + 1;
      while (end < source.length && source[end] === character) {
        end += 1;
      }
      const count = end - cursor;
      const threshold = character === ' ' ? 12 : 8;
      if (count >= threshold) {
        emit(cursor, `${MARKER}${character === ' ' ? 'S' : 'T'}${count};`);
        rawStart = end;
      }
      cursor = end;
    }
    if (rawStart < source.length) {
      chunks.push(source.slice(rawStart));
    }

    return {
      bytes: new TextEncoder().encode(chunks.join('')),
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
        'Whitespace RLE payload is not UTF-8',
        error,
      );
    }

    let cursor = 0;
    let byteLength = 0;
    let operations = 0;
    const operationLimit = Math.min(
      MAX_WHITESPACE_OPERATIONS,
      context.maxItems,
    );
    const chunks: string[] = [];
    const append = (chunk: string, knownBytes?: number): void => {
      const chunkBytes = knownBytes ?? Buffer.byteLength(chunk, 'utf8');
      if (chunkBytes > context.maxOutputBytes - byteLength) {
        throw new SemWitnessError(
          'DECODE_LIMIT',
          'Whitespace RLE expansion exceeds limit',
        );
      }
      byteLength += chunkBytes;
      chunks.push(chunk);
    };
    while (cursor < encoded.length) {
      const markerAt = encoded.indexOf(MARKER, cursor);
      if (markerAt < 0) {
        append(encoded.slice(cursor));
        break;
      }
      append(encoded.slice(cursor, markerAt));
      operations += 1;
      if (operations > operationLimit) {
        throw new SemWitnessError(
          'DECODE_LIMIT',
          'Whitespace marker count exceeds limit',
        );
      }
      const payloadStart = markerAt + MARKER.length;
      if (encoded.startsWith('E;', payloadStart)) {
        append(MARKER, MARKER.length);
        cursor = payloadStart + 2;
        continue;
      }
      const match = /^([ST])(\d{1,9});/u.exec(
        encoded.slice(payloadStart, payloadStart + 12),
      );
      if (match === null) {
        throw new SemWitnessError(
          'FORMAT_UNSUPPORTED',
          'Malformed whitespace RLE marker',
        );
      }
      const unit = match[1] === 'S' ? ' ' : '\t';
      const count = Number(match[2]);
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > context.maxOutputBytes - byteLength
      ) {
        throw new SemWitnessError(
          'DECODE_LIMIT',
          'Whitespace RLE expansion exceeds limit',
        );
      }
      append(unit.repeat(count), count);
      cursor = payloadStart + match[0].length;
    }

    const result = new TextEncoder().encode(chunks.join(''));
    if (result.byteLength > context.maxOutputBytes) {
      throw new SemWitnessError(
        'DECODE_LIMIT',
        'Whitespace RLE output exceeds limit',
      );
    }
    return result;
  }
}
