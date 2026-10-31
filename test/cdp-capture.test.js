import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpCapture } from '../src/lib/cdp-capture.js';
import { fromHarEntry } from '../src/lib/har.js';

const nextTick = () => new Promise((done) => { setTimeout(done, 5); });

function capture(overrides = {}) {
  const entries = [];
  const recorder = new CdpCapture({
    onEntry: (entry) => entries.push(entry),
    getBody: async () => ({ body: '{"ok":true}', base64Encoded: false }),
    getPostData: async () => 'posted',
    ...overrides,
  });
  return { entries, recorder };
}

const sent = (overrides = {}) => ({
  requestId: 'r1',
  wallTime: 1800000000,
  timestamp: 100,
  type: 'Fetch',
  request: { method: 'GET', url: 'https://api.test/items', headers: { Accept: '*/*' } },
  ...overrides,
});

const received = (overrides = {}) => ({
  requestId: 'r1',
  type: 'Fetch',
  hasExtraInfo: false,
  response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, mimeType: 'application/json' },
  ...overrides,
});

const finished = { requestId: 'r1', timestamp: 100.25, encodedDataLength: 42 };

test('a finished request becomes a HAR entry the app can read', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  const record = fromHarEntry(entries[0], 1);
  assert.equal(record.url, 'https://api.test/items');
  assert.equal(record.status, 200);
  assert.equal(record.resourceType, 'fetch');
  assert.equal(record.time, 250);
  assert.equal(record.responseSize, 42);
  assert.equal(record.mimeType, 'application/json');
});

test('the headers really sent replace the provisional ones', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.requestWillBeSentExtraInfo', {
    requestId: 'r1',
    headers: { Accept: '*/*', Cookie: 'sid=abc', Authorization: 'Bearer tok' },
  });
  recorder.handle('Network.responseReceivedExtraInfo', {
    requestId: 'r1',
    statusCode: 200,
    headers: { 'Set-Cookie': 'a=1\nb=2' },
  });
  recorder.handle('Network.responseReceived', received({ hasExtraInfo: true }));
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  const headers = entries[0].request.headers.map(({ name }) => name);
  assert.deepEqual(headers, ['Accept', 'Cookie', 'Authorization']);
  assert.equal(entries[0].response.headers[0].value, 'a=1\nb=2');
});

test('extra info that arrives before the request is kept for it', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { Cookie: 'early=1' } });
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  assert.equal(entries[0].request.headers[0].value, 'early=1');
});

test('an entry waits for response headers that arrive after it finished', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received({ hasExtraInfo: true }));
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  assert.equal(entries.length, 0);
  recorder.handle('Network.responseReceivedExtraInfo', { requestId: 'r1', statusCode: 200, headers: { 'Set-Cookie': 'late=1' } });
  await nextTick();
  assert.equal(entries[0].response.headers[0].name, 'Set-Cookie');
});

test('an entry is still released if those headers never come', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received({ hasExtraInfo: true }));
  recorder.handle('Network.loadingFinished', finished);
  await new Promise((done) => { setTimeout(done, 300); });
  assert.equal(entries.length, 1);
});

test('each hop of a redirect becomes its own entry', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.requestWillBeSent', sent({
    timestamp: 100.1,
    request: { method: 'GET', url: 'https://api.test/final', headers: {} },
    redirectResponse: { status: 302, statusText: 'Found', headers: { Location: '/final' }, mimeType: '' },
  }));
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  assert.deepEqual(entries.map((entry) => entry.response.status), [302, 200]);
  assert.deepEqual(entries.map((entry) => entry.request.url), ['https://api.test/items', 'https://api.test/final']);
  assert.equal(entries[0].getContent, undefined, 'a redirect has no body to fetch');
  assert.equal(typeof entries[1].getContent, 'function');
});

test('post data omitted from the event is fetched', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent({
    request: { method: 'POST', url: 'https://api.test/save', headers: { 'content-type': 'text/plain' }, hasPostData: true },
  }));
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  assert.deepEqual(entries[0].request.postData, { mimeType: 'text/plain', text: 'posted' });
});

test('response bodies are fetched on request', async () => {
  const { entries, recorder } = capture({
    getBody: async () => ({ body: 'aGk=', base64Encoded: true }),
  });
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  const [body, encoding] = await new Promise((done) => {
    entries[0].getContent((...args) => done(args));
  });
  assert.equal(body, 'aGk=');
  assert.equal(encoding, 'base64');
});

test('a body Chrome has already discarded is not fatal', async () => {
  const { entries, recorder } = capture({ getBody: () => Promise.reject(new Error('gone')) });
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  const body = await new Promise((done) => { entries[0].getContent(done); });
  assert.equal(body, null);
});

test('failed requests are reported with status 0', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.loadingFailed', { requestId: 'r1', timestamp: 100.1, errorText: 'net::ERR_FAILED', type: 'Fetch' });
  await nextTick();
  assert.equal(entries[0].response.status, 0);
  assert.equal(entries[0].response.statusText, 'net::ERR_FAILED');
});

test('data and blob URLs are ignored', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent({
    request: { method: 'GET', url: 'data:text/plain,hi', headers: {} },
  }));
  recorder.handle('Network.responseReceived', received());
  recorder.handle('Network.loadingFinished', finished);
  await nextTick();
  assert.equal(entries.length, 0);
});

test('requests with the same URL stay separate', async () => {
  const { entries, recorder } = capture();
  for (const requestId of ['a', 'b']) {
    recorder.handle('Network.requestWillBeSent', sent({ requestId }));
    recorder.handle('Network.responseReceived', received({ requestId }));
    recorder.handle('Network.loadingFinished', { ...finished, requestId });
  }
  await nextTick();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0]._key, entries[1]._key);
});

test('reset forgets requests still in flight', async () => {
  const { entries, recorder } = capture();
  recorder.handle('Network.requestWillBeSent', sent());
  recorder.handle('Network.responseReceived', received({ hasExtraInfo: true }));
  recorder.handle('Network.loadingFinished', finished);
  recorder.reset();
  await new Promise((done) => { setTimeout(done, 300); });
  assert.equal(entries.length, 0);
});
