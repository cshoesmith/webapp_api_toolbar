// One user session against the mock server. It runs in a real page during the
// browser test and in Node during script tests, so both record the same traffic.
globalThis.runFlow = async function runFlow(api, password = 'correct-horse-battery') {
  const json = (response) => response.json();
  const page = await (await api('/')).text();
  const csrf = /csrf-token" content="([^"]+)"/.exec(page)[1];

  const login = await json(await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sam@example.com', password }),
  }));
  const authorization = `Bearer ${login.data.access_token}`;
  const headers = { authorization };

  const me = await json(await api('/api/me', { headers }));
  await api(`/api/users/${me.user.id}/orders`, { headers });

  // Two pages and two details: the script should widen these to everything.
  const firstPage = await json(await api('/api/products?page=1&limit=2', { headers }));
  await api('/api/products?page=2&limit=2', { headers });
  for (const product of firstPage.products) {
    await api(`/api/products/${product.id}`, { headers });
  }

  const feed = await json(await api('/api/feed', { headers }));
  await api(`/api/feed?cursor=${encodeURIComponent(feed.meta.next)}`, { headers });

  const events = await json(await api('/api/events', { headers }));
  await api(events.next, { headers });

  await api('/api/notes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ owner: me.user.id, text: 'Hello from the flow', tags: ['a', 'b'] }),
  });
};
