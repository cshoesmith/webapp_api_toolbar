// Finds where each value in a request came from by replaying the session in
// time order and matching request values against earlier responses.
import { sameSite } from './classify.js';
import { jqPath, lastKey, slotsOf, walkJson } from './slots.js';

// Headers that describe the response rather than carry data for the next call.
const SKIP_RESPONSE_HEADER = /^(date|server|vary|age|via|expires|etag|last-modified|set-cookie|connection|keep-alive|transfer-encoding|content-.*|cache-control|pragma|access-control-.*|strict-transport-security|x-content-type-options|x-frame-options|x-xss-protection|referrer-policy|permissions-policy|cross-origin-.*|alt-svc|report-to|nel|cf-.*|x-cache.*|x-served-by|x-timer|x-request-id|x-amz-cf-.*|x-powered-by|accept-ranges|timing-allow-origin|server-timing)$/i;
const ID_KEY = /(^|[_-])(id|uuid|guid|slug|handle|key|token|cursor|next|after|marker|continuation|ref|code|sku)$|[a-z0-9](Id|ID|Uuid|Guid|Slug|Key|Token|Cursor|Marker|Ref|Code|Sku)$/;
// People type these. If one also appears in a response, that is a coincidence.
export const USER_INPUT_KEY = /pass(word|wd|phrase)?$|pwd$|otp$|(^|[_-])pin$/i;
const TOKEN_PATTERNS = [/[\w\-.~+/=%]{8,}/g, /[\w\-.~%]{8,}/g];

const MIN_TOKEN_LENGTH = 8;
const MAX_TEXT_BODIES = 64;
const TIMING_TOLERANCE_MS = 5;

function isOpaque(value) {
  return /\d/.test(value)
    || (value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value))
    || value.length >= 16;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keysMatch(a, b) {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left.length < 2 || right.length < 2) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

// Short or word-like values collide by chance ("active", 5), so they only count
// when the names on both sides say the value is an identifier.
function plausible(source, slot, whole) {
  const { value } = source;
  if (!whole) return value.length >= MIN_TOKEN_LENGTH && isOpaque(value);
  if (value.length >= 4 && isOpaque(value)) return true;
  if (!ID_KEY.test(source.key ?? '')) return false;
  return slot.kind === 'path' || ID_KEY.test(slot.key) || keysMatch(slot.key, source.key);
}

function score(source, slot) {
  let total = 0;
  if (keysMatch(slot.key, source.key ?? '')) total += 4;
  if (ID_KEY.test(source.key ?? '')) total += 2;
  if (source.kind === 'json') total += 1;
  return total;
}

function pickSource(candidates, slot, whole) {
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (!plausible(candidate, slot, whole)) continue;
    const candidateScore = score(candidate, slot);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

function urlParams(text) {
  const start = text.indexOf('?');
  if (start === -1 || !/^(https?:|\/)/i.test(text)) return [];
  const raw = text.slice(start + 1).split('#')[0];
  return raw.split('&').flatMap((pair) => {
    const split = pair.indexOf('=');
    if (split <= 0) return [];
    const rawValue = pair.slice(split + 1);
    try {
      return [{ param: pair.slice(0, split), rawValue, value: decodeURIComponent(rawValue) }];
    } catch {
      return [];
    }
  });
}

function parseSetCookie(header) {
  const first = header.split(';')[0];
  const split = first.indexOf('=');
  if (split <= 0) return null;
  return { name: first.slice(0, split).trim(), value: first.slice(split + 1).trim() };
}

export function setCookiesOf(record) {
  return record.responseHeaders
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .flatMap(({ value }) => value.split('\n'))
    .map(parseSetCookie)
    .filter(Boolean);
}

export function parseResponseJson(record) {
  if (record.responseBody === null || record.responseEncoding) return undefined;
  if (!/json/i.test(record.mimeType) && !/^\s*[{[]/.test(record.responseBody)) return undefined;
  try {
    return JSON.parse(record.responseBody);
  } catch {
    return undefined;
  }
}

function sourcesOf(record) {
  const sources = [];
  const recordId = record.id;
  const json = parseResponseJson(record);
  if (json !== undefined) {
    walkJson(json, (leaf, path) => {
      if (typeof leaf !== 'string' && typeof leaf !== 'number') return;
      const value = String(leaf);
      if (!value) return;
      const key = lastKey(path);
      sources.push({ recordId, kind: 'json', path, key, value });
      for (const { param, value: decoded, rawValue } of urlParams(value)) {
        sources.push({
          recordId,
          kind: 'jsonUrlParam',
          path,
          key: param,
          param,
          value: decoded,
          decode: decoded !== rawValue,
        });
      }
    });
  }
  for (const { name, value } of record.responseHeaders) {
    if (SKIP_RESPONSE_HEADER.test(name) || !value) continue;
    const key = name.toLowerCase();
    sources.push({ recordId, kind: 'header', name: key, key, value });
    for (const { param, value: decoded, rawValue } of urlParams(value)) {
      sources.push({
        recordId,
        kind: 'headerUrlParam',
        name: key,
        key: param,
        param,
        value: decoded,
        decode: decoded !== rawValue,
      });
    }
  }
  for (const { name, value } of setCookiesOf(record)) {
    if (!value) continue;
    sources.push({ recordId, kind: 'cookie', name, key: name, value });
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (decoded !== value) {
      sources.push({ recordId, kind: 'cookie', name, key: name, value: decoded, decode: true });
    }
  }
  return sources;
}

// Describes how to cut a value out of a text body using the literal text around
// it, for HTML pages and other bodies that have no parseable structure.
function textSource(record, index, value, slot) {
  const body = record.responseBody;
  const suffix = body[index + value.length];
  if (!suffix || value.includes(suffix)) return null;
  for (let length = 8; length <= 64; length += 8) {
    let prefix = body.slice(Math.max(0, index - length), index);
    prefix = prefix.slice(Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')) + 1);
    if (body.indexOf(prefix) + prefix.length === index) {
      return { recordId: record.id, kind: 'text', key: slot.key, prefix, suffix, value };
    }
  }
  return null;
}

// Only the consumer's own site counts. A long token turning up in someone else's
// script is usually a coincidence, and a missed link just keeps the recorded value.
function findInText(records, value, slot, consumer) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!sameSite(records[index].url, consumer.url)) continue;
    const position = records[index].responseBody.indexOf(value);
    if (position === -1) continue;
    const source = textSource(records[index], position, value, slot);
    if (source) return source;
  }
  return null;
}

export function sourceKey(source) {
  const where = source.path ? jqPath(source.path) : source.name ?? `${source.prefix}|${source.suffix}`;
  return [source.recordId, source.kind, where, source.param ?? '', source.decode ? 'decoded' : ''].join('|');
}

export function linkKey(link) {
  return `${link.consumerId}|${link.slotId}|${link.start}`;
}

function endOf(record) {
  return record.startedAt + record.time;
}

export function correlate(records) {
  const ordered = [...records].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  const known = new Map();
  const literal = new Set();
  const textBodies = [];
  const links = [];
  let unpublished = [];

  const publish = (record) => {
    for (const source of sourcesOf(record)) {
      if (literal.has(source.value)) continue;
      if (known.has(source.value)) known.get(source.value).push(source);
      else known.set(source.value, [source]);
    }
    if (record.responseBody !== null && !record.responseEncoding) {
      textBodies.push(record);
      if (textBodies.length > MAX_TEXT_BODIES) textBodies.shift();
    }
  };

  const addLink = (record, slot, start, value, source) => {
    links.push({
      consumerId: record.id,
      slotId: slot.id,
      slot,
      start,
      end: start + value.length,
      value,
      source,
    });
  };

  const matchWhole = (record, slot) => {
    const candidates = known.get(slot.value);
    const source = candidates && pickSource(candidates, slot, true);
    if (!source) return false;
    addLink(record, slot, 0, slot.value, source);
    return true;
  };

  const matchUrl = (record, slot) => {
    if (matchWhole(record, slot)) return;
    let relative;
    try {
      const parsed = new URL(slot.value);
      relative = { text: `${parsed.pathname}${parsed.search}`, start: parsed.origin.length };
    } catch {
      return;
    }
    const candidates = known.get(relative.text);
    const source = candidates && pickSource(candidates, slot, false);
    if (source) addLink(record, slot, relative.start, relative.text, source);
  };

  const matchTokens = (record, slot) => {
    const covered = [];
    const matched = [];
    for (const pattern of TOKEN_PATTERNS) {
      for (const match of slot.value.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (covered.some(([from, to]) => start < to && end > from)) continue;
        const candidates = known.get(match[0]);
        let source = candidates && pickSource(candidates, slot, false);
        if (!source && isOpaque(match[0]) && !literal.has(match[0])) {
          source = findInText(textBodies, match[0], slot, record);
        }
        if (source) {
          addLink(record, slot, start, match[0], source);
          covered.push([start, end]);
          matched.push(match[0]);
        }
      }
    }
    return matched;
  };

  ordered.forEach((record, index) => {
    unpublished.push(record);
    unpublished = unpublished.filter((pending) => {
      if (pending.id === record.id) return true;
      if (ordered.indexOf(pending) >= index) return true;
      if (endOf(pending) > record.startedAt + TIMING_TOLERANCE_MS) return true;
      publish(pending);
      return false;
    });

    const slots = slotsOf(record);
    for (const slot of slots) {
      if (!slot.value) continue;
      if (USER_INPUT_KEY.test(slot.key)) {
        literal.add(slot.value);
        continue;
      }
      if (slot.kind === 'url') {
        matchUrl(record, slot);
        continue;
      }
      if (matchWhole(record, slot)) continue;
      if (slot.kind === 'path') {
        literal.add(slot.value);
        continue;
      }
      if (slot.value.length >= MIN_TOKEN_LENGTH && matchTokens(record, slot).length) continue;
      literal.add(slot.value);
      for (const pattern of TOKEN_PATTERNS) {
        for (const [token] of slot.value.matchAll(pattern)) literal.add(token);
      }
    }
  });

  // A link on the whole URL already covers anything inside it.
  const wholeUrl = new Set(links.filter((link) => link.slotId === 'url').map((link) => link.consumerId));
  return links.filter((link) => {
    if (!wholeUrl.has(link.consumerId)) return true;
    return link.slotId === 'url' || !/^(path|query):/.test(link.slotId);
  });
}
