// Collapses repeated requests into loops: pagination and "fetch each item".
import { parseResponseJson, sourceKey } from './correlate.js';
import { parseBody, parseUrl, slotsOf } from './slots.js';

const CACHE_BUSTER = /^(_|_t|t|ts|timestamp|nocache|cb|rand|random|cachebuster)$/i;
const PAGE_KEY = /(^|[_-])(page|p|pagenumber|page_number|pageno|offset|skip|start|from)$|[a-z](Page|Offset|Skip)$/;
const OFFSET_KEY = /offset|skip|start|from/i;
const NEXT_SOURCE_KINDS = new Set(['json', 'jsonUrlParam', 'header', 'headerUrlParam']);
// Pagination over POST is common for search APIs, but only reads are safe to
// widen from "what was recorded" to "everything the server returns".
const READ_METHODS = new Set(['GET', 'HEAD']);
const PAGED_METHODS = new Set(['GET', 'HEAD', 'POST']);

function isVariableSegment(value) {
  return /\d/.test(value) || value.length >= 20;
}

function templateKey(record, inbound) {
  const { origin, segments } = parseUrl(record.url);
  const path = segments
    .map((segment) => (isVariableSegment(segment.value) || inbound.has(segment.id) ? '{}' : segment.value))
    .join('/');
  const body = parseBody(record);
  const operation = body?.type === 'json' ? body.json?.operationName ?? body.json?.query ?? '' : '';
  return [record.method, origin, path, String(operation)].join(' ');
}

function comparableSlots(record) {
  const values = new Map();
  for (const slot of slotsOf(record)) {
    if (!['path', 'query', 'json', 'form'].includes(slot.kind)) continue;
    if (slot.kind === 'query' && CACHE_BUSTER.test(slot.key)) continue;
    values.set(slot.id, slot);
  }
  return values;
}

function varyingSlots(members) {
  const maps = members.map(comparableSlots);
  const ids = new Set(maps.flatMap((map) => [...map.keys()]));
  return [...ids].filter((id) => {
    const first = maps[0].get(id)?.value;
    return maps.some((map) => map.get(id)?.value !== first);
  }).map((id) => ({ id, slots: maps.map((map) => map.get(id)) }));
}

// The biggest array in a page of results is almost always the results.
export function findItemsPath(json) {
  let best = null;
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      if (!best || node.length > best.length) best = { path, length: node.length };
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) visit(value, [...path, key]);
    }
  };
  visit(json, []);
  return best && best.length > 0 ? best.path : null;
}

function itemsPathOf(record) {
  const json = parseResponseJson(record);
  return json === undefined ? null : findItemsPath(json);
}

function detectNextUrl(members, linksOf) {
  const links = [];
  for (let index = 1; index < members.length; index += 1) {
    const link = linksOf(members[index]).find(
      (candidate) => candidate.slotId === 'url' && candidate.source.recordId === members[index - 1].id,
    );
    if (!link) return null;
    links.push(link);
  }
  return { type: 'nextUrl', members, slotId: 'url', link: links[0], items: itemsPathOf(members[0]) };
}

function detectCursor(members, varying, linksOf) {
  const links = [];
  for (let index = 1; index < members.length; index += 1) {
    const link = linksOf(members[index]).find(
      (candidate) => candidate.slotId === varying.id
        && candidate.source.recordId === members[index - 1].id
        && NEXT_SOURCE_KINDS.has(candidate.source.kind),
    );
    if (!link) return null;
    links.push(link);
  }
  const stripRecord = (link) => sourceKey({ ...link.source, recordId: 0 });
  if (links.some((link) => stripRecord(link) !== stripRecord(links[0]))) return null;
  return {
    type: 'cursor',
    members,
    slotId: varying.id,
    slot: varying.slots.find(Boolean),
    first: varying.slots[0] ?? null,
    link: links[0],
    items: itemsPathOf(members[0]),
  };
}

function detectCounter(members, varying) {
  const slot = varying.slots.find(Boolean);
  if (!['query', 'json', 'form', 'path'].includes(slot.kind)) return null;
  const firstMissing = !varying.slots[0];
  if (firstMissing && slot.kind !== 'query') return null;
  const known = varying.slots.filter(Boolean).map((item) => item.value);
  if (known.some((value) => !/^\d+$/.test(value))) return null;
  const numbers = known.map(Number);
  const isOffset = OFFSET_KEY.test(slot.key);
  const step = numbers.length > 1 ? numbers[1] - numbers[0] : isOffset ? numbers[0] : 1;
  if (step <= 0 || numbers.some((value, index) => value !== numbers[0] + index * step)) return null;
  const start = firstMissing ? numbers[0] - step : numbers[0];
  if (start < 0) return null;
  return {
    type: 'counter',
    members,
    slotId: varying.id,
    slot,
    firstMissing,
    start,
    step,
    items: itemsPathOf(members[0]),
  };
}

// Finds the one array index that differs between a list of JSON paths.
function differingIndex(paths) {
  const [first] = paths;
  if (paths.some((path) => path.length !== first.length)) return -1;
  const positions = first.flatMap((token, index) => {
    return paths.some((path) => path[index] !== token) ? [index] : [];
  });
  if (positions.length !== 1) return -1;
  return paths.every((path) => typeof path[positions[0]] === 'number') ? positions[0] : -1;
}

// IDs can sit at the same index on different pages, so a paged list is matched
// against its known items array rather than by which index differs.
function pageIteration(paths, paged) {
  const { items } = paged;
  const tail = paths[0].slice(items.length + 1);
  const fits = (path) => path.length === items.length + 1 + tail.length
    && items.every((token, index) => token === path[index])
    && typeof path[items.length] === 'number'
    && tail.every((token, index) => token === path[items.length + 1 + index]);
  return paths.every(fits) ? { group: paged, itemPath: tail } : null;
}

function detectForeach(members, varying, linksOf, groupOf) {
  if (!READ_METHODS.has(members[0].method)) return null;
  const links = members.map((member) => linksOf(member).find(
    (candidate) => candidate.slotId === varying.id
      && candidate.start === 0
      && candidate.end === candidate.slot.value.length
      && candidate.source.kind === 'json',
  ));
  if (links.some((link) => !link)) return null;
  const recordIds = new Set(links.map((link) => link.source.recordId));
  const [firstLink] = links;
  const { recordId } = firstLink.source;
  const foreach = {
    type: 'foreach',
    members,
    slotId: varying.id,
    slot: varying.slots[0],
    key: firstLink.source.key,
    sourceRecordId: recordId,
    iterate: null,
    pages: null,
  };
  const paths = links.map((link) => link.source.path);
  const paged = groupOf(recordId);
  if (paged?.items && [...recordIds].every((id) => groupOf(id) === paged)) {
    foreach.pages = pageIteration(paths, paged);
    if (foreach.pages) return foreach;
  }
  // A plain list must be a step that still exists, not a page swallowed by a loop.
  if (recordIds.size !== 1 || (paged && paged.members[0].id !== recordId)) return null;
  const position = differingIndex(paths);
  if (position === -1) return null;
  foreach.iterate = [...paths[0]];
  foreach.iterate[position] = null;
  return foreach;
}

export function detectGroups(steps, links) {
  const linksByConsumer = new Map();
  for (const link of links) {
    if (!linksByConsumer.has(link.consumerId)) linksByConsumer.set(link.consumerId, []);
    linksByConsumer.get(link.consumerId).push(link);
  }
  const linksOf = (record) => linksByConsumer.get(record.id) ?? [];

  const buckets = new Map();
  for (const record of steps) {
    const inbound = new Set(linksOf(record).map((link) => link.slotId));
    const key = templateKey(record, inbound);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }

  const repeated = [...buckets.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({ members, varying: varyingSlots(members) }));

  const groups = [];
  const memberGroup = new Map();
  const remember = (group) => {
    groups.push(group);
    for (const member of group.members) memberGroup.set(member.id, group);
  };
  const groupOf = (recordId) => memberGroup.get(recordId) ?? null;

  // Pagination goes first because a for-each loop can read from its results.
  const deferred = [];
  for (const entry of repeated) {
    const { members, varying } = entry;
    if (!PAGED_METHODS.has(members[0].method)) continue;
    const nextUrl = detectNextUrl(members, linksOf);
    if (nextUrl) {
      remember(nextUrl);
      continue;
    }
    if (varying.length !== 1) continue;
    const [slotChange] = varying;
    const cursor = detectCursor(members, slotChange, linksOf);
    if (cursor) {
      remember(cursor);
      continue;
    }
    const key = slotChange.slots.find(Boolean).key;
    const counter = PAGE_KEY.test(key) ? detectCounter(members, slotChange) : null;
    if (counter) remember(counter);
    else deferred.push(entry);
  }

  for (const { members, varying } of deferred) {
    const foreach = detectForeach(members, varying[0], linksOf, groupOf);
    const counter = foreach ? null : detectCounter(members, varying[0]);
    const group = foreach ?? counter;
    if (group) remember(group);
  }
  return groups;
}
