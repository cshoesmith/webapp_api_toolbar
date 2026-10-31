// Converts between HAR entries and the flat records the rest of the app uses.

export const MAX_BODY_CHARS = 2 * 1024 * 1024;

const TEXT_MIME = /json|xml|text|javascript|html|graphql|form-urlencoded|csv|yaml/i;

export function isTextMime(mimeType = '') {
  return TEXT_MIME.test(mimeType);
}

function decodeBase64Text(data) {
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Attach a response body to a record, decoding text and capping the size.
export function applyContent(record, text, encoding) {
  if (text === null || text === undefined || text === '') return record;
  let body = text;
  let bodyEncoding = encoding || null;
  if (encoding === 'base64' && isTextMime(record.mimeType)) {
    try {
      body = decodeBase64Text(text);
      bodyEncoding = null;
    } catch {
      return record;
    }
  }
  if (body.length > MAX_BODY_CHARS) {
    record.responseBody = bodyEncoding ? null : body.slice(0, MAX_BODY_CHARS);
    record.truncated = true;
  } else {
    record.responseBody = body;
  }
  record.responseEncoding = bodyEncoding;
  return record;
}

export function fromHarEntry(entry, id) {
  const { request = {}, response = {}, timings = {} } = entry;
  const content = response.content ?? {};
  const started = Date.parse(entry.startedDateTime);
  const record = {
    id,
    startedAt: Number.isNaN(started) ? 0 : started,
    time: Math.max(0, entry.time ?? 0),
    wait: Math.max(0, timings.wait ?? 0),
    method: (request.method ?? 'GET').toUpperCase(),
    url: request.url ?? '',
    status: response.status ?? 0,
    statusText: response.statusText ?? '',
    resourceType: entry._resourceType ?? '',
    requestHeaders: (request.headers ?? []).map(({ name, value }) => ({ name, value })),
    requestBody: null,
    responseHeaders: (response.headers ?? []).map(({ name, value }) => ({ name, value })),
    mimeType: (content.mimeType ?? '').split(';')[0].trim().toLowerCase(),
    responseSize: content.size ?? response.bodySize ?? 0,
    responseBody: null,
    responseEncoding: null,
    truncated: false,
  };
  const postData = request.postData;
  if (postData) {
    let text = postData.text ?? null;
    if (text === null && postData.params?.length) {
      text = postData.params
        .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value ?? '')}`)
        .join('&');
    }
    if (text !== null) {
      record.requestBody = { mimeType: postData.mimeType ?? '', text };
    }
  }
  if (content.text) applyContent(record, content.text, content.encoding);
  return record;
}

export function toHarEntry(record) {
  const url = new URL(record.url);
  const entry = {
    startedDateTime: new Date(record.startedAt).toISOString(),
    time: record.time,
    timings: { send: 0, wait: record.wait ?? 0, receive: 0 },
    _resourceType: record.resourceType,
    request: {
      method: record.method,
      url: record.url,
      httpVersion: 'HTTP/1.1',
      headers: record.requestHeaders,
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: record.requestBody?.text.length ?? 0,
    },
    response: {
      status: record.status,
      statusText: record.statusText,
      httpVersion: 'HTTP/1.1',
      headers: record.responseHeaders,
      cookies: [],
      content: {
        size: record.responseSize,
        mimeType: record.mimeType,
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: record.responseSize,
    },
    cache: {},
  };
  if (record.requestBody) {
    entry.request.postData = { ...record.requestBody };
  }
  if (record.responseBody !== null) {
    entry.response.content.text = record.responseBody;
    if (record.responseEncoding) entry.response.content.encoding = record.responseEncoding;
  }
  return entry;
}

export function toHar(records) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'API Toolbar', version: '0.1.0' },
      entries: records.map(toHarEntry),
    },
  };
}

export function fromHar(har, startId = 1) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file: log.entries is missing.');
  return entries.map((entry, index) => fromHarEntry(entry, startId + index));
}
