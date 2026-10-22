// -----------------------------------------------------------------------------
// HTTP downloads of the open data platforms: a timeout on every request, a
// size cap on every body (the sandbox has 256 MB), conditional requests
// (ETag / If-None-Match) when the server supports them, and a line by line
// reading of the national dynamic file, never held whole in memory.
//
// `fetch` is injectable: the tests never touch the network.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-irve (+https://github.com/guim31/gladys-irve)';

export class HttpError extends Error {
  constructor(message, status = null, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The Retry-After header of a 429 or a 503, in ms (seconds or an HTTP date). */
export function retryAfterMs(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Host of a URL, for messages and logs: never the path nor the query string. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

/** Why a request failed, in a few words: "timeout", "ENOTFOUND"… */
const reasonOf = (err) =>
  err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.message);

async function request(fetchImpl, url, timeoutMs, headers) {
  try {
    return await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HttpError(`${hostOf(url)}: ${reasonOf(err)}`);
  }
}

async function readCapped(response, url, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new HttpError(`${hostOf(url)}: response too large (${declared} bytes)`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new HttpError(`${hostOf(url)}: response too large`);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(`${hostOf(url)}: response too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/**
 * GET a body into memory. With `etag`, a 304 resolves `{ notModified: true }`.
 * @returns {Promise<{ body: Buffer|null, etag: string|null, notModified: boolean }>}
 */
export async function getBuffer(
  fetchImpl,
  url,
  { timeoutMs = 20000, maxBytes = 20e6, etag = null } = {},
) {
  const response = await request(fetchImpl, url, timeoutMs, {
    accept: 'application/json',
    ...(etag ? { 'if-none-match': etag } : {}),
  });
  if (response.status === 304) {
    await response.body?.cancel?.().catch(() => {});
    return { body: null, etag, notModified: true };
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new HttpError(
      `${hostOf(url)}: HTTP ${response.status}`,
      response.status,
      retryAfterMs(response),
    );
  }
  const body = await readCapped(response, url, maxBytes);
  return { body, etag: response.headers?.get?.('etag') ?? null, notModified: false };
}

/** Parses a JSON body, or says which host sent something else. */
export function parseJson(body, url) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(`${hostOf(url)}: invalid JSON`);
  }
}

/** GET a JSON document. */
export async function getJson(fetchImpl, url, options = {}) {
  const { body } = await getBuffer(fetchImpl, url, options);
  return parseJson(body, url);
}

/**
 * GET a text document and hand it over line by line (without the line
 * break), so that a file of 100 000 lines is filtered without being kept. The
 * body is fetched compressed (fetch decompresses it); `maxBytes` caps the
 * decompressed text (9 MB in October 2026), `maxLine` a line.
 * @param {(line: string) => void} onLine
 * @returns {Promise<number>} the number of lines read
 */
export async function getLines(
  fetchImpl,
  url,
  onLine,
  { timeoutMs = 60000, maxBytes = 30e6, maxLine = 100000 } = {},
) {
  const response = await request(fetchImpl, url, timeoutMs, {
    accept: 'text/csv',
    'accept-encoding': 'gzip',
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new HttpError(
      `${hostOf(url)}: HTTP ${response.status}`,
      response.status,
      retryAfterMs(response),
    );
  }
  const decoder = new TextDecoder();
  let size = 0;
  let rest = '';
  let count = 0;
  const flush = (text, last) => {
    const parts = (rest + text).split('\n');
    rest = last ? '' : parts.pop();
    if (rest.length > maxLine) {
      throw new HttpError(`${hostOf(url)}: line too long`);
    }
    for (const part of parts) {
      const line = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (line !== '') {
        count += 1;
        onLine(line);
      }
    }
  };
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new HttpError(`${hostOf(url)}: response too large`);
      }
      flush(decoder.decode(chunk, { stream: true }), false);
    }
  } catch (err) {
    await response.body?.cancel?.().catch(() => {});
    throw err instanceof HttpError ? err : new HttpError(`${hostOf(url)}: ${reasonOf(err)}`);
  }
  flush(decoder.decode(), true);
  return count;
}
