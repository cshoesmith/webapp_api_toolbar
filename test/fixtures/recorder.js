// Stands in for the browser in Node: runs requests and keeps HAR-shaped records.
import { fromHarEntry } from '../../src/lib/har.js';

export function createRecorder(base, { cookies: initial = [] } = {}) {
  const records = [];
  const jar = new Map(initial.map((cookie) => cookie.split('=')));

  const api = async (path, init = {}) => {
    const url = new URL(path, base).href;
    const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 Test', ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const started = Date.now();
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    const text = await response.text();
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...rest] = cookie.split(';')[0].split('=');
      jar.set(name, rest.join('='));
    }
    const entry = {
      startedDateTime: new Date(started).toISOString(),
      time: Date.now() - started,
      _resourceType: 'fetch',
      request: {
        method: init.method ?? 'GET',
        url,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      },
      response: {
        status: response.status,
        headers: [
          ...[...response.headers].filter(([name]) => name !== 'set-cookie'),
          ...response.headers.getSetCookie().map((value) => ['set-cookie', value]),
        ].map(([name, value]) => ({ name, value })),
        content: { mimeType: response.headers.get('content-type') ?? '', text },
      },
    };
    if (init.body !== undefined) {
      entry.request.postData = { mimeType: headers['content-type'] ?? '', text: init.body };
    }
    records.push(fromHarEntry(entry, records.length + 1));
    return new Response(text, { status: response.status, headers: { 'content-type': entry.response.content.mimeType } });
  };

  return { api, records };
}
