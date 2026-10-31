// A mock API that behaves like a real one: tokens, CSRF values and cursors are
// random, and rotate() revokes them all. A script only works against it if it
// fetches fresh values instead of replaying recorded ones.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export const PASSWORD = 'correct-horse-battery';
export const DEVICE_COOKIE = 'device=dev-5551212';

const PRODUCTS = ['p_1001', 'p_1002', 'p_1003', 'p_1004', 'p_1005'];
const random = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(/;\s*/).filter(Boolean).map((pair) => {
    const split = pair.indexOf('=');
    return [pair.slice(0, split), pair.slice(split + 1)];
  }));
}

export async function startServer() {
  const state = { sessions: new Map(), tokens: new Map(), cursors: new Map(), notes: [], echoes: [], hits: [] };
  const flow = await readFile(new URL('./flow.js', import.meta.url), 'utf8');

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const type = typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json';
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(text);
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://mock.test');
    const path = url.pathname;
    state.hits.push(`${req.method} ${req.url}`);
    const cookies = parseCookies(req.headers.cookie);
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const account = state.tokens.get(token);

    if (path === '/') {
      const sid = random('sid');
      const csrf = random('csrf');
      state.sessions.set(sid, csrf);
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width">`
        + `<meta name="csrf-token" content="${csrf}"><title>Mock shop</title></head>`
        + `<body><h1>Mock shop</h1><script>document.cookie = "${DEVICE_COOKIE}; path=/";</script>`
        + `<script src="/flow.js"></script></body></html>`;
      return send(res, 200, html, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
    }
    if (path === '/flow.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(flow);
    }
    if (path === '/page/sam') return send(res, 200, '<!doctype html><html><body><h1>Profile of Sam</h1></body></html>');
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    // Works while recording, then turns into an HTML error page, as a site does
    // when it blocks a replayed request.
    if (path === '/api/gate') {
      if (state.gateClosed) return send(res, 403, '<!doctype html><html><body>Blocked page body</body></html>');
      return send(res, 200, { open: true });
    }
    if (path === '/api/echo') {
      state.echoes.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      return send(res, 200, { ok: true });
    }
    // Rejects anything without Origin, and tells browsers to cache the answer.
    if (path === '/api/embed') {
      if (!req.headers.origin) {
        return send(res, 400, { error: 'The origin header was not set in the request.', code: 1006 });
      }
      state.embedOrigin = req.headers.origin;
      return send(res, 200, { campaign: 'c_123' }, {
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=600',
      });
    }
    if (path === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse(raw);
      if (password !== PASSWORD) return send(res, 401, { error: 'bad password' });
      const accessToken = random('tok');
      state.tokens.set(accessToken, { userId: random('usr') });
      return send(res, 200, { data: { access_token: accessToken } });
    }

    if (!account) return send(res, 401, { error: 'bad token' });
    if (cookies.device !== DEVICE_COOKIE.split('=')[1]) return send(res, 403, { error: 'unknown device' });

    if (path === '/api/me') return send(res, 200, { user: { id: account.userId, name: 'Sam' } });
    const orders = /^\/api\/users\/([^/]+)\/orders$/.exec(path);
    if (orders) {
      if (orders[1] !== account.userId) return send(res, 404, { error: 'no such user' });
      return send(res, 200, { orders: [{ total: 12 }] });
    }
    if (path === '/api/products') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 2);
      const slice = PRODUCTS.slice((page - 1) * limit, page * limit);
      return send(res, 200, { products: slice.map((id) => ({ id })), total: PRODUCTS.length });
    }
    const product = /^\/api\/products\/([^/]+)$/.exec(path);
    if (product) return send(res, 200, { id: product[1], name: `Product ${product[1]}` });
    if (path === '/api/feed') {
      const cursor = url.searchParams.get('cursor');
      const position = cursor ? state.cursors.get(cursor) : 0;
      if (position === undefined) return send(res, 400, { error: 'bad cursor' });
      const next = position < 2 ? random('cur+/=') : null;
      if (next) state.cursors.set(next, position + 1);
      return send(res, 200, { entries: [{ position }], meta: { next } });
    }
    if (path === '/api/events') {
      const after = url.searchParams.get('after');
      const position = after ? state.cursors.get(after) : 0;
      if (position === undefined) return send(res, 400, { error: 'bad after' });
      let next = null;
      if (position < 2) {
        const value = random('evt');
        state.cursors.set(value, position + 1);
        next = `/api/events?after=${value}`;
      }
      return send(res, 200, { events: [{ position }], next });
    }
    if (path === '/api/notes' && req.method === 'POST') {
      if (state.sessions.get(cookies.sid) !== req.headers['x-csrf-token']) {
        return send(res, 403, { error: 'bad csrf' });
      }
      const note = JSON.parse(raw);
      if (note.owner !== account.userId) return send(res, 403, { error: 'wrong owner' });
      state.notes.push(note);
      return send(res, 200, { note: { id: random('note') } });
    }
    return send(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    // A different origin on the same server, for cross-origin calls.
    otherBase: `http://localhost:${server.address().port}`,
    // Everything issued so far stops working, as it would on a later day.
    rotate() {
      state.sessions.clear();
      state.tokens.clear();
      state.cursors.clear();
      state.notes.length = 0;
      state.hits.length = 0;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
