import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { bashPath } from './bash-path.js';
import { isApiRequest, isThirdParty } from '../src/lib/classify.js';
import { toCurl } from '../src/lib/curl.js';
import { fromHar, toHar } from '../src/lib/har.js';
import { shellQuote } from '../src/lib/shell.js';
import { record } from './helpers.js';

// Sent over stdin so Windows argument handling cannot alter the quoting.
function bashEcho(quoted) {
  return execFileSync(bashPath(), ['-s'], { input: `printf %s ${quoted}`, encoding: 'utf8' });
}

test('shellQuote survives a real shell for hostile values', () => {
  const values = [
    `it's`,
    '$(echo pwned)',
    '`echo pwned`',
    'a\nb\tc',
    `'; echo pwned #`,
    'back\\slash',
    '"double"',
    'ünï çødé',
  ];
  for (const value of values) assert.equal(bashEcho(shellQuote(value)), value);
});

test('curl drops transport headers and uses -b for cookies', () => {
  const command = toCurl(record({
    url: 'https://api.example.com/v1/me',
    headers: {
      ':authority': 'api.example.com',
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'content-length': '0',
      'sec-fetch-mode': 'cors',
      'if-none-match': 'W/"abc"',
      cookie: 'sid=abc',
    },
  }));
  assert.match(command, /^curl 'https:\/\/api\.example\.com\/v1\/me'/);
  assert.match(command, /-H 'accept: application\/json'/);
  assert.match(command, /-b 'sid=abc'/);
  assert.doesNotMatch(command, /authority|accept-encoding|content-length|sec-fetch|if-none-match/);
  assert.doesNotMatch(command, /-X/);
});

test('full mode keeps browser headers', () => {
  const command = toCurl(record({
    url: 'https://x.test/a',
    headers: { 'sec-fetch-mode': 'cors', 'if-none-match': 'abc' },
  }), { clean: false });
  assert.match(command, /sec-fetch-mode/);
  assert.match(command, /if-none-match/);
});

test('curl picks the right method flag', () => {
  const post = toCurl(record({ method: 'POST', url: 'https://x.test/a', body: { a: 1 } }));
  assert.doesNotMatch(post, /-X/);
  assert.match(post, /--data-raw '\{"a":1\}'/);
  const put = toCurl(record({ method: 'PUT', url: 'https://x.test/a', body: { a: 1 } }));
  assert.match(put, /-X 'PUT'/);
  const head = toCurl(record({ method: 'HEAD', url: 'https://x.test/a' }));
  assert.match(head, / -I /);
  const del = toCurl(record({ method: 'DELETE', url: 'https://x.test/a' }));
  assert.match(del, /-X 'DELETE'/);
});

test('redaction removes credentials from url, headers, cookies and body', () => {
  const command = toCurl(record({
    method: 'POST',
    url: 'https://x.test/a?token=topsecret1&page=2',
    headers: {
      authorization: 'Bearer topsecret2',
      'x-api-key': 'topsecret3',
      cookie: 'sid=topsecret4; theme=dark',
    },
    body: { password: 'topsecret5', name: 'kept', nested: { client_secret: 'topsecret6' } },
  }), { redact: true });
  assert.doesNotMatch(command, /topsecret/);
  assert.match(command, /page=2/);
  assert.match(command, /Bearer REDACTED/);
  assert.match(command, /kept/);
});

test('uploads carry a warning', () => {
  const command = toCurl(record({
    method: 'POST',
    url: 'https://x.test/upload',
    bodyType: 'multipart/form-data; boundary=x',
    body: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n\r\n--x--',
  }));
  assert.match(command, /^# Warning/);
});

test('API filter keeps data calls and drops page furniture', () => {
  const api = (fields) => isApiRequest(record({ url: 'https://app.test/x', ...fields }));
  assert.equal(api({ resourceType: 'xhr' }), true);
  assert.equal(api({ resourceType: 'fetch' }), true);
  assert.equal(api({ resourceType: 'document', responseType: 'text/html' }), true);
  assert.equal(api({ resourceType: 'document', method: 'POST', responseType: 'text/html' }), true);
  assert.equal(api({ resourceType: 'image', responseType: 'image/png' }), false);
  assert.equal(api({ resourceType: 'script', responseType: 'text/javascript' }), false);
  assert.equal(api({ url: 'https://app.test/app.js', resourceType: 'fetch' }), false);
  assert.equal(api({ url: 'https://www.google-analytics.com/g/collect', resourceType: 'fetch' }), false);
  assert.equal(api({ method: 'OPTIONS', resourceType: 'fetch' }), false);
  assert.equal(api({ url: 'https://www.google.com/recaptcha/api2/clr?k=abc', resourceType: 'xhr' }), false);
  assert.equal(api({ url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', resourceType: 'fetch' }), false);
  assert.equal(api({ url: 'https://newassets.hcaptcha.com/c/abc', resourceType: 'xhr' }), false);
  assert.equal(api({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js', resourceType: 'fetch' }), false);
  assert.equal(api({ url: 'https://www.google.com/search?q=recaptcha', resourceType: 'fetch' }), true);
  assert.equal(api({ url: 'wss://app.test/socket', resourceType: 'websocket' }), false);
});

test('a cross-origin call with no recorded Origin gets it from the Referer', () => {
  const made = record({
    url: 'https://widgets.example.net/embed',
    headers: { referer: 'https://shop.example.com/login' },
    resourceType: 'fetch',
  });
  assert.deepEqual(made.requestHeaders.at(-1), { name: 'origin', value: 'https://shop.example.com' });
  assert.match(toCurl(made), /-H 'origin: https:\/\/shop\.example\.com'/);
});

test('Origin is only added where a browser would send it', () => {
  const originOf = (fields) => record({ url: 'https://api.test/a', ...fields })
    .requestHeaders.filter(({ name }) => name.toLowerCase() === 'origin');
  assert.equal(originOf({ headers: { referer: 'https://api.test/page' } }).length, 0, 'same origin');
  assert.equal(originOf({ headers: {} }).length, 0, 'no Referer to use');
  assert.equal(originOf({ headers: { referer: 'not a url' } }).length, 0, 'unusable Referer');
  assert.equal(originOf({ headers: { referer: 'https://other.test/' }, resourceType: 'document' }).length, 0, 'page load');
  const recorded = originOf({ headers: { Origin: 'https://real.test', referer: 'https://other.test/' } });
  assert.deepEqual(recorded, [{ name: 'Origin', value: 'https://real.test' }], 'a recorded value is kept');
});

test('calls to other sites are third party, but a site\'s own hosts are not', () => {
  const made = (url, documentUrl) => ({ url, documentUrl });
  const page = 'https://shop.example.com/user/sam';
  assert.equal(isThirdParty(made('https://ads.example.net/prebid.js', page)), true);
  assert.equal(isThirdParty(made('https://shop.example.com/profile/stats', page)), false);
  assert.equal(isThirdParty(made('https://api.example.com/v4/user', page)), false);
  assert.equal(isThirdParty(made('https://ads.example.net/x', '')), false, 'unknown page');
});

test('HAR export and import round trip', () => {
  const original = record({
    method: 'POST',
    url: 'https://x.test/a?b=1',
    headers: { authorization: 'Bearer abc' },
    body: { hello: 'world' },
    response: { ok: true },
    resourceType: 'xhr',
  });
  const [restored] = fromHar(JSON.parse(JSON.stringify(toHar([original]))), original.id);
  assert.deepEqual(restored, { ...original, wait: 0 });
  original.documentUrl = 'https://x.test/page';
  const [withPage] = fromHar(JSON.parse(JSON.stringify(toHar([original]))), original.id);
  assert.equal(withPage.documentUrl, 'https://x.test/page');
});

test('importing something that is not a HAR fails clearly', () => {
  assert.throws(() => fromHar({ nope: true }), /Not a HAR file/);
});
