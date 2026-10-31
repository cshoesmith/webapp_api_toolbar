// Breaks a request into the individual places a value can sit: path segments,
// query parameters, custom headers, and body fields.

// Standard headers never carry a value that came from an earlier response.
const SKIP_REQUEST_HEADER = /^(:.*|host|connection|content-length|content-type|accept|accept-encoding|accept-language|user-agent|referer|origin|cookie|cache-control|pragma|dnt|priority|sec-.*|if-.*|upgrade-insecure-requests|x-requested-with|range|te)$/i;

const MAX_JSON_LEAVES = 20000;

function safeDecode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function safeDecodePath(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function parseUrl(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname
    .split('/')
    .slice(1)
    .map((raw, index) => ({ raw, value: safeDecodePath(raw), id: `path:${index}` }));
  const seen = new Map();
  const query = parsed.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const split = pair.indexOf('=');
      const rawName = split === -1 ? pair : pair.slice(0, split);
      const rawValue = split === -1 ? '' : pair.slice(split + 1);
      const name = safeDecode(rawName);
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      return { rawName, rawValue, name, value: safeDecode(rawValue), id: `query:${name}#${occurrence}` };
    });
  return { origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, segments, query };
}

export function parseBody(record) {
  const body = record.requestBody;
  if (!body?.text) return null;
  const mime = body.mimeType ?? '';
  if (/form-urlencoded/i.test(mime)) {
    const seen = new Map();
    const fields = [...new URLSearchParams(body.text)].map(([name, value]) => {
      const occurrence = seen.get(name) ?? 0;
      seen.set(name, occurrence + 1);
      return { name, value, id: `form:${name}#${occurrence}` };
    });
    return { type: 'form', fields };
  }
  if (/json/i.test(mime) || /^\s*[{[]/.test(body.text)) {
    try {
      return { type: 'json', json: JSON.parse(body.text) };
    } catch {
      return { type: 'raw', text: body.text };
    }
  }
  return { type: 'raw', text: body.text };
}

// Renders path tokens as a jq filter. A null token means "every array element".
export function jqPath(tokens) {
  const text = tokens
    .map((token) => {
      if (token === null) return '[]';
      if (typeof token === 'number') return `[${token}]`;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ? `.${token}` : `[${JSON.stringify(token)}]`;
    })
    .join('');
  if (!text) return '.';
  return text.startsWith('[') ? `.${text}` : text;
}

export function walkJson(root, visit) {
  let leaves = 0;
  const walk = (node, path) => {
    if (leaves >= MAX_JSON_LEAVES) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
    } else {
      leaves += 1;
      visit(node, path);
    }
  };
  walk(root, []);
}

export function lastKey(path) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (typeof path[index] === 'string') return path[index];
  }
  return '';
}

export function slotsOf(record) {
  const slots = [{ id: 'url', kind: 'url', key: 'url', value: record.url }];
  let url;
  try {
    url = parseUrl(record.url);
  } catch {
    return slots;
  }
  url.segments.forEach((segment, index) => {
    if (!segment.value) return;
    slots.push({ id: segment.id, kind: 'path', key: url.segments[index - 1]?.value ?? '', value: segment.value });
  });
  for (const param of url.query) {
    slots.push({ id: param.id, kind: 'query', key: param.name, value: param.value });
  }
  for (const { name, value } of record.requestHeaders) {
    if (SKIP_REQUEST_HEADER.test(name)) continue;
    slots.push({ id: `header:${name.toLowerCase()}`, kind: 'header', key: name.toLowerCase(), value });
  }
  const body = parseBody(record);
  if (body?.type === 'json') {
    walkJson(body.json, (leaf, path) => {
      slots.push({
        id: `json:${jqPath(path)}`,
        kind: 'json',
        key: lastKey(path),
        value: leaf === null ? '' : String(leaf),
        path,
        jsonType: leaf === null ? 'null' : typeof leaf,
      });
    });
  } else if (body?.type === 'form') {
    for (const field of body.fields) {
      slots.push({ id: field.id, kind: 'form', key: field.name, value: field.value });
    }
  } else if (body?.type === 'raw') {
    slots.push({ id: 'raw', kind: 'raw', key: 'body', value: body.text });
  }
  return slots;
}
