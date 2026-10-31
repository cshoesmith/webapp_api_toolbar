// Builds records the same way the panel does, from HAR-shaped entries.
import { fromHarEntry } from '../src/lib/har.js';

let clock = Date.parse('2026-10-31T10:00:00Z');
let nextId = 1;

export function resetClock() {
  clock = Date.parse('2026-10-31T10:00:00Z');
  nextId = 1;
}

export function record({
  method = 'GET',
  url,
  headers = {},
  body,
  bodyType = 'application/json',
  status = 200,
  response,
  responseType = 'application/json',
  responseHeaders = {},
  resourceType = 'fetch',
}) {
  const text = response === undefined
    ? undefined
    : typeof response === 'string' ? response : JSON.stringify(response);
  const entry = {
    startedDateTime: new Date(clock).toISOString(),
    time: 20,
    _resourceType: resourceType,
    request: {
      method,
      url,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
    response: {
      status,
      headers: Object.entries(responseHeaders).flatMap(([name, value]) => {
        return [value].flat().map((item) => ({ name, value: item }));
      }),
      content: { mimeType: responseType, text },
    },
  };
  if (body !== undefined) {
    entry.request.postData = {
      mimeType: bodyType,
      text: typeof body === 'string' ? body : JSON.stringify(body),
    };
  }
  clock += 100;
  nextId += 1;
  return fromHarEntry(entry, nextId - 1);
}
