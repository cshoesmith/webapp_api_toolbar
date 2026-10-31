import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correlate, linkKey } from '../src/lib/correlate.js';
import { generate, loadTemplates } from '../src/lib/generate.js';
import { record, resetClock } from './helpers.js';

await loadTemplates();

const API = 'https://api.example.com';

function fresh(fn) {
  return () => {
    resetClock();
    fn();
  };
}

test('a login token flows into later requests', fresh(() => {
  const records = [
    record({
      method: 'POST',
      url: `${API}/login`,
      body: { email: 'a@b.co', password: 'hunter2hunter2' },
      response: { data: { access_token: 'tok_abcdef123456' } },
    }),
    record({
      url: `${API}/me`,
      headers: { authorization: 'Bearer tok_abcdef123456' },
      response: { id: 'usr_998877', name: 'Sam' },
    }),
    record({
      url: `${API}/users/usr_998877/orders`,
      headers: { authorization: 'Bearer tok_abcdef123456' },
      response: { orders: [] },
    }),
  ];
  const { plan, script } = generate(records, {});
  assert.deepEqual(plan.flows.map((flow) => flow.name), ['ACCESS_TOKEN', 'ID']);
  assert.match(script, /ACCESS_TOKEN=\$\(jget "\$RESP" '\.data\.access_token'\)/);
  assert.match(script, /"authorization: Bearer \$\{ACCESS_TOKEN\}"/);
  assert.match(script, /users\/\$\{ID\}\/orders/);
  assert.doesNotMatch(script, /tok_abcdef123456/);
  assert.doesNotMatch(script, /usr_998877/);
}));

test('passwords and API keys move out of the script', fresh(() => {
  const records = [
    record({
      method: 'POST',
      url: `${API}/login`,
      body: { user: 'sam', password: 'hunter2hunter2' },
      headers: { 'x-api-key': 'key_live_12345678' },
      response: { ok: true },
    }),
  ];
  const { plan, script, env } = generate(records, {});
  assert.deepEqual(plan.config.map((item) => item.name).sort(), ['API_KEY', 'PASSWORD']);
  assert.doesNotMatch(script, /hunter2hunter2|key_live_12345678/);
  assert.match(env, /PASSWORD='hunter2hunter2'/);
  assert.deepEqual(plan.warnings.filter((text) => /still contains/.test(text)), []);
  const embedded = generate(records, { embedSecrets: true });
  assert.match(embedded.script, /hunter2hunter2/);
  assert.equal(embedded.env, '');
}));

test('a secret inside a Referer URL is still scrubbed', fresh(() => {
  const records = [
    record({
      url: `${API}/a?token=sekret_value_1`,
      headers: { referer: 'https://app.example.com/page?token=sekret_value_1' },
      response: {},
    }),
  ];
  const { script } = generate(records, {});
  assert.doesNotMatch(script, /sekret_value_1/);
}));

test('values the browser sent first are not treated as derived', fresh(() => {
  const records = [
    record({ url: `${API}/search?client=abc12345`, response: { client: 'abc12345' } }),
    record({ url: `${API}/other?client=abc12345`, response: {} }),
  ];
  assert.equal(correlate(records).length, 0);
}));

test('common words and small numbers do not link by accident', fresh(() => {
  const records = [
    record({ url: `${API}/a`, response: { status: 'active', count: 5, id: 7, total: 50 } }),
    record({ url: `${API}/b?status=active&limit=5&size=50`, response: {} }),
  ];
  assert.equal(correlate(records).length, 0);
}));

test('a small id links into a URL path', fresh(() => {
  const records = [
    record({ url: `${API}/a`, response: { team: { id: 7 } } }),
    record({ url: `${API}/teams/7/members`, response: {} }),
  ];
  const links = correlate(records);
  assert.equal(links.length, 1);
  assert.equal(links[0].slotId, 'path:1');
}));

test('a request cannot use a response that had not arrived yet', fresh(() => {
  const slow = record({ url: `${API}/slow`, response: { token: 'tok_race_condition' } });
  slow.time = 5000;
  const fast = record({ url: `${API}/fast?token=tok_race_condition`, response: {} });
  assert.equal(correlate([slow, fast]).length, 0);
}));

test('CSRF tokens are lifted from HTML', fresh(() => {
  const html = '<html><head><meta name="viewport" content="x"><meta name="csrf-token" content="Xy9zK2mQ4vLp8RtW"></head></html>';
  const records = [
    record({ url: 'https://app.example.com/', response: html, responseType: 'text/html', resourceType: 'document' }),
    record({
      method: 'POST',
      url: 'https://app.example.com/save',
      headers: { 'x-csrf-token': 'Xy9zK2mQ4vLp8RtW' },
      body: { a: 1 },
      response: {},
    }),
  ];
  const { script } = generate(records, { selectedIds: [2] });
  assert.match(script, /between "\$RESP" 'token" content="' '"'/);
  assert.doesNotMatch(script, /Xy9zK2mQ4vLp8RtW/);
}));

test('a password is never treated as coming from a response', fresh(() => {
  const records = [
    record({ url: `${API}/app.bundle`, response: 'var dev = "hunter2hunter2!";', responseType: 'text/javascript' }),
    record({ method: 'POST', url: `${API}/login`, body: { password: 'hunter2hunter2' }, response: {} }),
  ];
  const { plan, env } = generate(records, { selectedIds: [2] });
  assert.equal(plan.steps.length, 1);
  assert.match(env, /PASSWORD=/);
}));

test('an API key in a JavaScript bundle is lifted from the bundle', fresh(() => {
  const records = [
    record({ url: `${API}/app.bundle`, response: 'init({apiKey:"AIzaSyD4x9Kq7Lm2Pz",x:1})', responseType: 'text/javascript' }),
    record({ url: `${API}/data`, headers: { 'x-api-key': 'AIzaSyD4x9Kq7Lm2Pz' }, response: {} }),
  ];
  const { plan, script } = generate(records, { selectedIds: [2] });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.config.length, 0);
  assert.match(script, /between "\$RESP" '.*apiKey:"' '"'/);
}));

test('double-submit cookies are read from the jar', fresh(() => {
  const records = [
    record({
      url: `${API}/init`,
      response: {},
      responseHeaders: { 'set-cookie': ['XSRF-TOKEN=abc%3D123456789; Path=/', 'sid=s3ssion123; HttpOnly'] },
    }),
    record({
      method: 'POST',
      url: `${API}/save`,
      headers: { 'x-xsrf-token': 'abc=123456789', cookie: 'XSRF-TOKEN=abc%3D123456789; sid=s3ssion123' },
      body: { a: 1 },
      response: {},
    }),
  ];
  const { plan, script } = generate(records, {});
  assert.match(script, /urldecode "\$\(jar_get 'XSRF-TOKEN'\)"/);
  assert.equal(plan.config.length, 0, 'jar cookies need no user input');
  assert.doesNotMatch(script, / -b "\$COOKIES/);
}));

test('browser cookies stay on their own host', fresh(() => {
  const records = [
    record({ url: 'https://a.example.com/one', headers: { cookie: 'sid=aaa111222' }, response: {} }),
    record({ url: 'https://b.example.com/two', headers: { cookie: 'sid=bbb333444' }, response: {} }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.config.length, 2);
  assert.match(script, /seed_cookies 'a\.example\.com' "\$COOKIES_A_EXAMPLE_COM"/);
  assert.match(script, /seed_cookies 'b\.example\.com' "\$COOKIES_B_EXAMPLE_COM"/);
  assert.doesNotMatch(script, / -b "\$COOKIES/);
}));

test('a browser cookie the server rotates is not sent again', fresh(() => {
  const records = [
    record({
      url: `${API}/start`,
      headers: { cookie: 'sid=old_session_1' },
      responseHeaders: { 'set-cookie': 'sid=new_session_2; Path=/' },
      response: {},
    }),
    record({ url: `${API}/next`, headers: { cookie: 'sid=new_session_2' }, response: {} }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.seedCookies.length, 1);
  assert.doesNotMatch(script, /new_session_2/);
  const seed = script.indexOf('seed_cookies \'api');
  assert.ok(seed !== -1 && seed < script.indexOf('# Step 1'), 'the jar is seeded before the first request');
}));

test('selecting one request pulls in what it depends on', fresh(() => {
  const records = [
    record({ url: `${API}/noise`, response: { unrelated: true } }),
    record({ url: `${API}/session`, response: { sessionToken: 'sess_123456789' } }),
    record({ url: `${API}/data`, headers: { 'x-session': 'sess_123456789' }, response: {} }),
  ];
  const { plan } = generate(records, { selectedIds: [3] });
  assert.deepEqual(plan.steps.map((step) => step.record.id), [2, 3]);
  assert.equal(plan.steps[0].auto, true);
  assert.equal(plan.steps[1].auto, false);
}));

test('disabling a link keeps the literal and drops the dependency', fresh(() => {
  const records = [
    record({ url: `${API}/a`, response: { ref: 'ref_123456789' } }),
    record({ url: `${API}/b?ref=ref_123456789`, response: {} }),
  ];
  const [link] = correlate(records);
  const { plan, script } = generate(records, { selectedIds: [2], disabledLinks: new Set([linkKey(link)]) });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.disabled.length, 1);
  assert.match(script, /ref=ref_123456789/);
}));

test('page numbers become a counter loop', fresh(() => {
  const records = [1, 2, 3].map((page) => record({
    url: `${API}/items?page=${page}&limit=2`,
    response: { items: [{ id: `i${page}a` }, { id: `i${page}b` }], total: 6 },
  }));
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].loop.type, 'counter');
  assert.match(script, /PAGE=1\n/);
  assert.match(script, /page=\$\{PAGE\}&limit=2/);
  assert.match(script, /PAGE=\$\(\( PAGE \+ 1 \)\)/);
  assert.match(script, /\(\.items \/\/ \[\]\) \| length/);
}));

test('page 1 with no page parameter is still paginated', fresh(() => {
  const records = [
    record({ url: `${API}/items`, response: { items: [1, 2] } }),
    record({ url: `${API}/items?page=2`, response: { items: [3] } }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps[0].loop.start, 1);
  assert.match(script, /items\?page=\$\{PAGE\}/);
}));

test('offsets step by the page size', fresh(() => {
  const records = [0, 20, 40].map((offset) => record({
    url: `${API}/items?offset=${offset}`,
    response: [{ id: offset }],
  }));
  const { plan } = generate(records, {});
  assert.equal(plan.steps[0].loop.step, 20);
  assert.deepEqual(plan.steps[0].loop.items, []);
}));

test('cursors become a loop that reads the next cursor', fresh(() => {
  const records = [
    record({ url: `${API}/feed`, response: { items: [{ a: 1 }], meta: { next: 'cur_aaaaaaaaaa' } } }),
    record({ url: `${API}/feed?cursor=cur_aaaaaaaaaa`, response: { items: [{ a: 2 }], meta: { next: 'cur_bbbbbbbbbb' } } }),
    record({ url: `${API}/feed?cursor=cur_bbbbbbbbbb`, response: { items: [{ a: 3 }], meta: { next: null } } }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].loop.type, 'cursor');
  assert.match(script, /CURSOR=\$\(jq -r '\.meta\.next \/\/ empty'/);
  assert.match(script, /URL\+="\?cursor=\$\(urlencode "\$CURSOR"\)"/);
  assert.match(script, /request "01_get_feed_\$\{pass\}\.json" 'GET' "\$URL"/);
}));

test('next links become a loop', fresh(() => {
  const records = [
    record({ url: `${API}/feed`, response: { results: [1], next: `${API}/feed?p=abc123456` } }),
    record({ url: `${API}/feed?p=abc123456`, response: { results: [2], next: null } }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps[0].loop.type, 'nextUrl');
  assert.match(script, /NEXT=\$\(jq -r '\.next \/\/ empty'/);
}));

test('GraphQL pagination over POST loops on the variable', fresh(() => {
  const query = 'query Feed($after: String) { feed(after: $after) { id } }';
  const records = [
    record({
      method: 'POST',
      url: `${API}/graphql`,
      body: { operationName: 'Feed', query, variables: { after: null } },
      response: { data: { feed: { nodes: [{ id: 1 }], endCursor: 'cursor_0000001' } } },
    }),
    record({
      method: 'POST',
      url: `${API}/graphql`,
      body: { operationName: 'Feed', query, variables: { after: 'cursor_0000001' } },
      response: { data: { feed: { nodes: [{ id: 2 }], endCursor: null } } },
    }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].loop.type, 'cursor');
  assert.match(script, /if \$a0 == "" then null else \$a0 end/);
}));

test('list then detail becomes a for-each loop', fresh(() => {
  const records = [
    record({ url: `${API}/products`, response: { products: [{ id: 'p_1001' }, { id: 'p_1002' }, { id: 'p_1003' }] } }),
    record({ url: `${API}/products/p_1001`, response: { name: 'One' } }),
    record({ url: `${API}/products/p_1002`, response: { name: 'Two' } }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].loop.type, 'foreach');
  assert.match(script, /jq -r '\.products\[\]\.id'/);
  assert.match(script, /while IFS= read -r ID; do/);
}));

test('for-each loops read every page of a paginated list', fresh(() => {
  const records = [
    record({ url: `${API}/products?page=1`, response: { products: [{ id: 'p_1001' }, { id: 'p_1002' }] } }),
    record({ url: `${API}/products?page=2`, response: { products: [{ id: 'p_1003' }] } }),
    record({ url: `${API}/products/p_1001`, response: { name: 'One' } }),
    record({ url: `${API}/products/p_1003`, response: { name: 'Three' } }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 2);
  assert.match(script, /jq -r '\.id' "\$OUT_DIR\/01_get_products\.ndjson"/);
}));

test('writes never widen into a for-each loop', fresh(() => {
  const records = [
    record({ url: `${API}/items`, response: { items: [{ id: 'it_1001' }, { id: 'it_1002' }, { id: 'it_1003' }] } }),
    record({ method: 'DELETE', url: `${API}/items/it_1001`, status: 204 }),
    record({ method: 'DELETE', url: `${API}/items/it_1002`, status: 204 }),
  ];
  const { plan, script } = generate(records, {});
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every((step) => step.loop === null));
  assert.doesNotMatch(script, /while IFS/);
  assert.ok(plan.warnings.some((text) => /change data/.test(text)));
}));

test('repeated identical reads collapse to one step', fresh(() => {
  const records = [1, 2, 3].map(() => record({ url: `${API}/poll`, response: {} }));
  assert.equal(generate(records, {}).plan.steps.length, 1);
}));

test('repeated writes are kept', fresh(() => {
  const records = [1, 2].map(() => record({ method: 'POST', url: `${API}/vote`, body: { a: 1 }, response: {} }));
  assert.equal(generate(records, {}).plan.steps.length, 2);
}));

test('variable names never clobber the shell or the script', fresh(() => {
  const records = [
    record({
      url: `${API}/a`,
      response: { path: '/srv/data/99999', user: 'usr_12345', home: 'home_12345' },
    }),
    record({
      url: `${API}/b?path=/srv/data/99999&user=usr_12345&home=home_12345`,
      response: {},
    }),
  ];
  const names = generate(records, {}).plan.flows.map((flow) => flow.name);
  for (const name of ['PATH', 'USER', 'HOME']) assert.ok(!names.includes(name));
  assert.equal(names.length, 3);
}));

test('computed signatures and expired tokens are flagged', fresh(() => {
  const payload = Buffer.from(JSON.stringify({ exp: 1000000000 })).toString('base64url');
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJl`;
  const records = [
    record({ url: `${API}/a`, headers: { 'x-signature': 'sig111', authorization: `Bearer ${jwt}` }, response: {} }),
    record({ url: `${API}/b`, headers: { 'x-signature': 'sig222', authorization: `Bearer ${jwt}` }, response: {} }),
  ];
  const { plan } = generate(records, {});
  assert.ok(plan.warnings.some((text) => /x-signature/.test(text)));
  assert.ok(plan.warnings.some((text) => /expired/.test(text)));
}));

test('a hostile recording cannot inject commands', fresh(() => {
  const evil = "x'; touch PWNED; echo '";
  const records = [
    record({
      url: `${API}/a`,
      response: { [`to${evil}ken`]: 'tok_inject_12345', ok: 'value$(touch PWNED)`touch PWNED`' },
      responseHeaders: { 'x-next': 'hdr_token_123456' },
    }),
    record({
      method: 'POST',
      url: `${API}/b%0Atouch%20PWNED/$(touch PWNED)?q=${encodeURIComponent(evil)}&t=tok_inject_12345`,
      headers: { 'x-evil': `$(touch PWNED)${evil}`, 'x-next': 'hdr_token_123456' },
      body: { note: evil, nested: { 'k"\'$(x)': '`touch PWNED`' } },
      response: {},
    }),
  ];
  const { script } = generate(records, {});
  const comments = script.split('\n').filter((line) => line.startsWith('# Step'));
  assert.equal(comments.length, 2);
  assert.ok(comments.every((line) => !/\n/.test(line)));
}));
