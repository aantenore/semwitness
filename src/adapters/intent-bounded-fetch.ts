export type IntentBoundedFetchFailureCode =
  | 'invalid_configuration'
  | 'request_rejected'
  | 'request_aborted'
  | 'request_timeout'
  | 'upstream_redirect'
  | 'upstream_response_invalid'
  | 'upstream_response_too_large'
  | 'network_failure';

/** Content-free by construction: URLs, bodies, credentials, and causes stay out. */
export class IntentBoundedFetchError extends Error {
  readonly code: IntentBoundedFetchFailureCode;
  readonly statusCode: number | undefined;

  constructor(code: IntentBoundedFetchFailureCode, statusCode?: number) {
    super(code);
    this.name = 'IntentBoundedFetchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CreateIntentBoundedFetchOptions {
  readonly baseUrl: string;
  readonly allowedPathname: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof globalThis.fetch;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function configurationError(): never {
  throw new IntentBoundedFetchError('invalid_configuration');
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map(Number);
  return (
    numbers.every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        String(octet) === octets[index],
    ) && numbers[0] === 127
  );
}

function hasUnsafePathEncoding(pathname: string): boolean {
  // The adapter owns one exact endpoint. Encoded path bytes add no capability
  // here and can be decoded a different number of times by clients, gateways,
  // and upstream servers.
  return pathname.includes('\\') || pathname.includes('%');
}

function parseBaseUrl(value: string): URL {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    hasUnsafePathEncoding(value) ||
    /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(value)
  ) {
    return configurationError();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configurationError();
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    hasUnsafePathEncoding(url.pathname)
  ) {
    return configurationError();
  }
  return url;
}

function normalizedPathPrefix(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/u, '');
  return pathname === '' ? '/' : pathname;
}

function isWithinPathPrefix(pathname: string, prefix: string): boolean {
  return prefix === '/'
    ? pathname.startsWith('/')
    : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function parseAllowedPathname(value: string, prefix: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\') ||
    hasUnsafePathEncoding(value) ||
    !isWithinPathPrefix(value, prefix) ||
    new URL(value, 'https://semwitness.invalid').pathname !== value
  ) {
    return configurationError();
  }
  return value;
}

function parseRequestUrl(value: string): URL {
  if (
    hasUnsafePathEncoding(value) ||
    /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(value)
  ) {
    throw new IntentBoundedFetchError('request_rejected');
  }
  try {
    return new URL(value);
  } catch {
    throw new IntentBoundedFetchError('request_rejected');
  }
}

interface RequestSnapshot {
  readonly fetchInput: FetchInput;
  readonly fetchInit: RequestInit | undefined;
  readonly requestUrl: URL;
  readonly callerSignal: AbortSignal | undefined;
  readonly method: string;
}

function snapshotRequest(
  input: FetchInput,
  init: RequestInit | undefined,
): RequestSnapshot {
  if (input instanceof Request) {
    try {
      const request = new Request(input, init);
      return {
        fetchInput: request,
        fetchInit: undefined,
        requestUrl: parseRequestUrl(request.url),
        callerSignal: request.signal,
        method: request.method,
      };
    } catch {
      throw new IntentBoundedFetchError('request_rejected');
    }
  }

  let rawUrl: string;
  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    try {
      rawUrl = URL.prototype.toString.call(input);
    } catch {
      throw new IntentBoundedFetchError('request_rejected');
    }
  } else {
    throw new IntentBoundedFetchError('request_rejected');
  }

  const requestUrl = parseRequestUrl(rawUrl);
  return {
    fetchInput: requestUrl.href,
    fetchInit: init,
    requestUrl,
    callerSignal: init?.signal ?? undefined,
    method: init?.method ?? 'GET',
  };
}

function validatePositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) configurationError();
}

function assertedContentLength(
  response: Response,
  maxResponseBytes: number,
): void {
  const header = response.headers.get('content-length');
  if (header === null) return;
  if (!/^\d+$/u.test(header)) {
    throw new IntentBoundedFetchError(
      'upstream_response_invalid',
      response.status,
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new IntentBoundedFetchError(
      'upstream_response_invalid',
      response.status,
    );
  }
  if (length > maxResponseBytes) {
    throw new IntentBoundedFetchError(
      'upstream_response_too_large',
      response.status,
    );
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cancellation must never replace the stable bounded error.
  }
}

function abortableRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => undefined);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (response.body === null) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortableRead(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new IntentBoundedFetchError(
          'upstream_response_too_large',
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof IntentBoundedFetchError) throw error;
    throw new IntentBoundedFetchError('network_failure', response.status);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A custom stream may retain a pending read after cancellation.
    }
  }

  const body = new ArrayBuffer(total);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function reconstructedResponse(
  response: Response,
  body: ArrayBuffer,
): Response {
  const statusForbidsBody =
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  return new Response(
    statusForbidsBody || body.byteLength === 0 ? null : body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

/**
 * Host-controlled origin/path boundary with a whole-response deadline, redirect
 * denial, caller cancellation, and declared plus streamed body-size limits.
 */
export function createIntentBoundedFetch(
  options: CreateIntentBoundedFetchOptions,
): typeof globalThis.fetch {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const allowedPathname = parseAllowedPathname(
    options.allowedPathname,
    normalizedPathPrefix(baseUrl),
  );
  validatePositiveInteger(options.timeoutMs);
  validatePositiveInteger(options.maxResponseBytes);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async (input, init) => {
    const snapshot = snapshotRequest(input, init);
    const { requestUrl } = snapshot;
    if (
      requestUrl.origin !== baseUrl.origin ||
      requestUrl.pathname !== allowedPathname ||
      snapshot.method !== 'POST' ||
      requestUrl.username !== '' ||
      requestUrl.password !== '' ||
      requestUrl.search !== '' ||
      requestUrl.hash !== '' ||
      hasUnsafePathEncoding(requestUrl.pathname)
    ) {
      throw new IntentBoundedFetchError('request_rejected');
    }

    const callerSignal = snapshot.callerSignal;
    if (isAborted(callerSignal)) {
      throw new IntentBoundedFetchError('request_aborted');
    }

    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, options.timeoutMs);
    const signal =
      callerSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([callerSignal, timeoutController.signal]);

    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const abortFailure = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        new IntentBoundedFetchError(
          timedOut ? 'request_timeout' : 'request_aborted',
        ),
      );
    signal.addEventListener('abort', onAbort, { once: true });

    const performFetch = async () => {
      const response = await fetchImplementation(snapshot.fetchInput, {
        ...snapshot.fetchInit,
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        throw new IntentBoundedFetchError('upstream_redirect', response.status);
      }
      try {
        assertedContentLength(response, options.maxResponseBytes);
      } catch (error) {
        await cancelBody(response);
        throw error;
      }
      const body = await readBoundedBody(
        response,
        options.maxResponseBytes,
        signal,
      );
      return reconstructedResponse(response, body);
    };

    try {
      return await Promise.race([performFetch(), abortFailure]);
    } catch (error) {
      if (
        error instanceof IntentBoundedFetchError &&
        error.code !== 'network_failure'
      ) {
        throw error;
      }
      if (timedOut) {
        throw new IntentBoundedFetchError('request_timeout');
      }
      if (isAborted(callerSignal)) {
        throw new IntentBoundedFetchError('request_aborted');
      }
      if (error instanceof IntentBoundedFetchError) throw error;
      throw new IntentBoundedFetchError('network_failure');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
