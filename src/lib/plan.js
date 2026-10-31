// Works out what a generated script has to do: which requests to run, which
// values flow between them, and what the user must supply.
import { correlate, linkKey, setCookiesOf, sourceKey, USER_INPUT_KEY } from './correlate.js';
import { hasOmittedUpload } from './curl.js';
import { detectGroups } from './patterns.js';
import { hostOf, isChallenge, isTracker } from './classify.js';
import { isJwt, isSecretHeader, isSecretParam, jwtExpiry, splitAuthScheme } from './secrets.js';
import { commentSafe, slug, toVarName } from './shell.js';
import { jqPath, parseUrl, slotsOf } from './slots.js';

// Assigning to these would break the script or the shell running it.
// PowerShell ignores case, so its internal names are listed in capitals too.
const RESERVED_NAMES = [
  'BODY', 'DELAY', 'ENV_FILE', 'HOME', 'HOSTNAME', 'IFS', 'JAR', 'LANG', 'MAX_ITEMS', 'MAX_PAGES',
  'NEXT', 'OUT_DIR', 'PATH', 'PWD', 'RANDOM', 'RESP', 'RESP_HEADERS', 'SECONDS', 'SHELL', 'TERM',
  'UID', 'URL', 'USER', 'VALUE',
  'ARGS', 'CLIENT', 'COOKIES', 'DELAYMS', 'ENVFILE', 'ENVLINE', 'ERROR', 'EVENT', 'FALSE', 'FIRST',
  'FOREACH', 'HANDLER', 'HOST', 'INPUT', 'ITEMS', 'MATCHES', 'MAXITEMS', 'MAXPAGES', 'MISSING',
  'NEXTVALUE', 'NULL', 'OFS', 'OUTDIR', 'OUTPUTFILE', 'PAGENUMBER', 'PID', 'PROFILE', 'PSITEM',
  'REQUESTBODY', 'REQUESTURL', 'SENDER', 'SWITCH', 'THIS', 'TRUE',
];
const GENERIC_KEY = /^(id|uuid|guid|name|value|key|token|code|slug)$/i;
const WRAPPER_KEY = /^(data|result|results|response|payload|attributes|body)$/i;
const TRACE_HEADER = /^(traceparent|tracestate|baggage|x-request-id|x-correlation-id|x-amzn-trace-id|x-b3-.*|x-datadog-.*|x-cloud-trace-context|sentry-trace)$/i;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CAPTCHA_FIELD = /captcha|turnstile/i;

function isReplayable(record) {
  return /^https?:/i.test(record.url)
    && record.status > 0
    && record.method !== 'OPTIONS'
    && record.resourceType !== 'websocket';
}

// A login is behind a CAPTCHA if it sends an answer, or sends a password on a
// page that was seen running a bot check.
function isBehindCaptcha(record, sawChallenge) {
  return slotsOf(record).some(({ kind, key }) => {
    if (kind === 'url' || kind === 'path') return false;
    return CAPTCHA_FIELD.test(key) || (sawChallenge && USER_INPUT_KEY.test(key));
  });
}

function createNames() {
  const used = new Set(RESERVED_NAMES);
  return (base) => {
    const clean = toVarName(base);
    let name = clean;
    for (let index = 2; used.has(name); index += 1) name = `${clean}_${index}`;
    used.add(name);
    return name;
  };
}

function singular(word) {
  return word.length > 3 && /[^s]s$/i.test(word) ? word.slice(0, -1) : word;
}

function sourceBaseName(source) {
  if (source.kind === 'json') {
    const keys = source.path.filter((token) => typeof token === 'string');
    const last = keys.at(-1) ?? 'value';
    const parent = keys.at(-2);
    return GENERIC_KEY.test(last) && parent && !WRAPPER_KEY.test(parent)
      ? `${singular(parent)}_${last}`
      : last;
  }
  if (source.param) return source.param;
  if (source.kind === 'header') return source.name.replace(/^x-/, '');
  if (source.kind === 'cookie') return source.name;
  return source.key || 'value';
}

function describeSource(source) {
  switch (source.kind) {
    case 'json': return jqPath(source.path);
    case 'jsonUrlParam': return `${jqPath(source.path)} (URL parameter ${source.param})`;
    case 'header': return `response header ${source.name}`;
    case 'headerUrlParam': return `response header ${source.name} (URL parameter ${source.param})`;
    case 'cookie': return `cookie ${source.name}`;
    default: return 'text in the response';
  }
}

function describeSlot(slot) {
  switch (slot.kind) {
    case 'url': return 'request URL';
    case 'path': return 'URL path';
    case 'query': return `query parameter ${slot.key}`;
    case 'header': return `header ${slot.key}`;
    case 'json': return `body field ${jqPath(slot.path)}`;
    case 'form': return `form field ${slot.key}`;
    default: return 'request body';
  }
}

function fileBase(record, number) {
  const words = parseUrl(record.url).segments
    .map((segment) => segment.value)
    .filter((value) => value && !/\d/.test(value) && value.length < 20)
    .slice(-2);
  const label = slug([record.method, ...words].join(' ')).slice(0, 48);
  return `${String(number).padStart(2, '0')}_${label}`;
}

function fileExtension(record) {
  if (/json/.test(record.mimeType)) return 'json';
  if (/html/.test(record.mimeType)) return 'html';
  if (/xml/.test(record.mimeType)) return 'xml';
  if (/csv/.test(record.mimeType)) return 'csv';
  if (/text/.test(record.mimeType)) return 'txt';
  return record.responseBody === null ? 'bin' : 'txt';
}

function requestCookies(record) {
  const header = record.requestHeaders.find(({ name }) => name.toLowerCase() === 'cookie');
  if (!header) return [];
  return header.value.split(';').flatMap((pair) => {
    const split = pair.indexOf('=');
    if (split === -1) return [];
    return [{ name: pair.slice(0, split).trim(), value: pair.slice(split + 1).trim() }];
  });
}

function isSecretSlot(slot) {
  if (slot.jsonType === 'boolean' || slot.jsonType === 'null') return false;
  if (isJwt(slot.value)) return true;
  if (slot.kind === 'header') return isSecretHeader(slot.key);
  if (slot.kind === 'query' || slot.kind === 'form' || slot.kind === 'json') return isSecretParam(slot.key);
  return false;
}

function includeDependencies(selected, links) {
  const included = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (included.has(link.consumerId) && !included.has(link.source.recordId)) {
        included.add(link.source.recordId);
        changed = true;
      }
    }
  }
  return included;
}

function dropRepeatedReads(records, links) {
  const feeds = new Set(links.map((link) => link.source.recordId));
  const seen = new Set();
  return records.filter((record) => {
    if (record.method !== 'GET' || feeds.has(record.id)) return true;
    const key = record.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jwtWarning(entry, now) {
  const expiry = jwtExpiry(entry.value);
  if (expiry === null) return null;
  const when = new Date(expiry).toISOString();
  return expiry <= now
    ? `${entry.name} is a JWT that expired at ${when}. Replace it before running the script.`
    : `${entry.name} is a JWT that expires at ${when}. Capture a new one after that.`;
}

function computedHeaderWarnings(included, links) {
  const linked = new Set(links.map((link) => `${link.consumerId}|${link.slotId}`));
  const values = new Map();
  for (const record of included) {
    for (const slot of slotsOf(record)) {
      if (slot.kind !== 'header' || TRACE_HEADER.test(slot.key)) continue;
      if (linked.has(`${record.id}|${slot.id}`)) continue;
      if (!values.has(slot.key)) values.set(slot.key, new Set());
      values.get(slot.key).add(slot.value);
    }
  }
  return [...values].filter(([, seen]) => seen.size > 1).map(([key]) => (
    `Header ${commentSafe(key)} changes between requests and no earlier response contains it. `
    + 'The page probably computes it in JavaScript, so a replayed value may be rejected.'
  ));
}

export function buildPlan(records, options = {}) {
  const {
    selectedIds = records.map((record) => record.id),
    disabledLinks = new Set(),
    embedSecrets = false,
    keepBrowserHeaders = false,
    scriptName = 'api_script',
    now = Date.now(),
  } = options;

  // Bot checks and trackers run only if ticked. They are not offered as sources,
  // so they can never be pulled in as a dependency of something else.
  const ticked = new Set(selectedIds);
  const replayable = records
    .filter(isReplayable)
    .filter((record) => ticked.has(record.id) || !(isTracker(record) || isChallenge(record)));
  const byId = new Map(replayable.map((record) => [record.id, record]));
  const allLinks = correlate(replayable);
  const activeLinks = allLinks.filter((link) => !disabledLinks.has(linkKey(link)));

  const selected = selectedIds.filter((id) => byId.has(id));
  const includedIds = includeDependencies(selected, activeLinks);
  const included = replayable
    .filter((record) => includedIds.has(record.id))
    .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  const scopedLinks = activeLinks.filter((link) => includedIds.has(link.consumerId));

  const ordered = dropRepeatedReads(included, scopedLinks);
  const orderedIds = new Set(ordered.map((record) => record.id));
  const groups = detectGroups(ordered, scopedLinks.filter((link) => orderedIds.has(link.consumerId)));

  const absorbed = new Set();
  const leaderGroup = new Map();
  for (const group of groups) {
    leaderGroup.set(group.members[0].id, group);
    for (const member of group.members.slice(1)) absorbed.add(member.id);
  }
  const live = ordered.filter((record) => !absorbed.has(record.id));
  const liveIds = new Set(live.map((record) => record.id));
  const warnings = [];

  const liveLinks = scopedLinks.filter((link) => {
    if (!liveIds.has(link.consumerId)) return false;
    const group = leaderGroup.get(link.consumerId);
    if (group && group.type !== 'nextUrl' && link.slotId === group.slotId) return false;
    if (liveIds.has(link.source.recordId)) return true;
    warnings.push(
      `A value in ${describeSlot(link.slot)} came from a page inside a loop, so its recorded value is used as-is.`,
    );
    return false;
  });

  const steps = live.map((record, index) => {
    const number = index + 1;
    return {
      number,
      record,
      group: leaderGroup.get(record.id) ?? null,
      auto: !selected.includes(record.id),
      file: fileBase(record, number),
      extension: fileExtension(record),
      binds: new Map(),
      extracts: [],
      loop: null,
    };
  });
  const stepOf = new Map(steps.map((step) => [step.record.id, step]));
  const allocate = createNames();

  const bind = (step, slot, binding) => {
    if (!step.binds.has(slot.id)) step.binds.set(slot.id, []);
    step.binds.get(slot.id).push(binding);
  };

  // Values that flow from one response into a later request.
  const flows = new Map();
  for (const link of liveLinks) {
    const key = sourceKey(link.source);
    if (!flows.has(key)) {
      const name = allocate(sourceBaseName(link.source));
      const from = stepOf.get(link.source.recordId);
      const flow = { name, from: from.number, where: describeSource(link.source), value: link.value, uses: [] };
      flows.set(key, flow);
      from.extracts.push({ name, source: link.source });
    }
    const flow = flows.get(key);
    const consumer = stepOf.get(link.consumerId);
    flow.uses.push({ step: consumer.number, where: describeSlot(link.slot), key: linkKey(link) });
    bind(consumer, link.slot, {
      start: link.start,
      end: link.end,
      name: flow.name,
      encode: encodeURIComponent(link.value) !== link.value,
    });
  }

  // Loops bind their changing slot to a loop variable.
  for (const step of steps) {
    const { group } = step;
    if (!group) continue;
    if (group.type === 'counter') {
      const name = allocate(group.slot.key || 'page');
      step.loop = { type: 'counter', name, start: group.start, step: group.step, items: group.items };
      step.loop.recorded = group.members.length;
      if (group.firstMissing) step.loop.extraQuery = { name: group.slot.key, var: name };
      else bind(step, group.slot, { start: 0, end: group.slot.value.length, name, encode: false });
    } else if (group.type === 'cursor') {
      const name = allocate(group.slot.key || 'cursor');
      step.loop = {
        type: 'cursor',
        name,
        source: group.link.source,
        initial: group.first?.value ?? '',
        items: group.items,
      };
      if (group.first) {
        const emptyAsNull = group.first.jsonType === 'null';
        bind(step, group.first, {
          start: 0,
          end: group.first.value.length,
          name,
          encode: true,
          emptyAsNull,
        });
      } else {
        step.loop.extraQuery = { name: group.slot.key, var: name };
      }
    } else if (group.type === 'nextUrl') {
      step.loop = { type: 'nextUrl', source: group.link.source, prefix: step.record.url.slice(0, group.link.start), items: group.items };
    } else {
      const name = allocate(`${singular(group.key)}`);
      const sourceStep = stepOf.get(group.sourceRecordId);
      step.loop = { type: 'foreach', name, iterate: group.iterate, pages: group.pages, sourceStep };
      step.loop.pagedStep = group.pages ? stepOf.get(group.pages.group.members[0].id) : null;
      bind(step, group.slot, {
        start: 0,
        end: group.slot.value.length,
        name,
        encode: encodeURIComponent(group.slot.value) !== group.slot.value,
      });
    }
  }

  // Everything else that is sensitive becomes a setting the user supplies.
  const config = new Map();
  const addConfig = (value, base, reason) => {
    if (!config.has(value)) config.set(value, { name: allocate(base), value, reason });
    return config.get(value).name;
  };

  for (const step of steps) {
    const { record } = step;
    const urlBound = step.binds.has('url');
    for (const slot of slotsOf(record)) {
      if (slot.kind === 'url' || !slot.value || step.binds.has(slot.id)) continue;
      if (urlBound && (slot.kind === 'path' || slot.kind === 'query')) continue;
      if (!isSecretSlot(slot)) continue;
      if (slot.kind === 'header') {
        const { prefix, token, scheme } = splitAuthScheme(slot.value);
        const base = scheme ? 'access_token' : slot.key.replace(/^x-/, '');
        const name = addConfig(token, base, `Sent in the ${slot.key} header`);
        bind(step, slot, { start: prefix.length, end: slot.value.length, name, encode: false });
      } else {
        const name = addConfig(slot.value, slot.key, `Sent as ${describeSlot(slot)}`);
        bind(step, slot, { start: 0, end: slot.value.length, name, encode: encodeURIComponent(slot.value) !== slot.value });
      }
    }
  }

  // Cookies a response set go through the cookie jar. The rest were already in
  // the browser, so they seed the jar once, per host, before the first request.
  // A later Set-Cookie then replaces them, as it would in the browser. Sending
  // them with every request instead would undo any session rotation.
  const hostCookies = new Map();
  const jarCookies = new Map();
  for (const step of steps) {
    const host = hostOf(step.record.url);
    const known = jarCookies.get(host) ?? new Set();
    const needed = requestCookies(step.record).filter(({ name }) => !known.has(name));
    if (needed.length) {
      if (!hostCookies.has(host)) hostCookies.set(host, { url: step.record.url, cookies: new Map() });
      const { cookies } = hostCookies.get(host);
      for (const { name, value } of needed) if (!cookies.has(name)) cookies.set(name, value);
    }
    for (const { name } of setCookiesOf(step.record)) known.add(name);
    jarCookies.set(host, known);
  }
  const seedCookies = [...hostCookies].map(([host, { url, cookies }]) => {
    const value = [...cookies].map(([name, cookie]) => `${name}=${cookie}`).join('; ');
    const { hostname, origin } = new URL(url);
    return { hostname, origin, name: addConfig(value, `cookies_${host}`, `Browser cookies for ${host}`) };
  });

  for (const entry of config.values()) {
    const warning = jwtWarning(entry, now);
    if (warning) warnings.push(warning);
  }
  warnings.push(...computedHeaderWarnings(included, scopedLinks));

  const mutating = steps.filter((step) => MUTATING.has(step.record.method));
  if (mutating.length) {
    const list = mutating.map((step) => step.number).join(', ');
    warnings.push(`Step${mutating.length > 1 ? 's' : ''} ${list} can change data on the server each time the script runs.`);
  }
  const sawChallenge = records.some(isChallenge);
  const captchaSteps = steps.filter((step) => isBehindCaptcha(step.record, sawChallenge));
  if (captchaSteps.length) {
    const list = captchaSteps.map((step) => step.number).join(', ');
    const subject = captchaSteps.length > 1 ? `Steps ${list} log` : `Step ${list} logs`;
    warnings.unshift(
      `${subject} in behind a CAPTCHA, which a script cannot pass. `
      + 'Log in by hand, then press Record, so the script can reuse your session.',
    );
  }
  for (const step of steps) {
    if (hasOmittedUpload(step.record)) {
      warnings.push(`Step ${step.number} uploaded a file. Chrome does not expose file bytes, so edit this step before running it.`);
    }
    if (step.record.status >= 400) {
      warnings.push(`Step ${step.number} returned HTTP ${step.record.status} when recorded, so the script lets it fail.`);
    }
    if (step.record.fromCache) {
      warnings.push(`Step ${step.number} came from the browser cache in the imported file, so some of its headers may be missing. If it fails, record it again with the toolbar.`);
    }
    if (step.record.truncated) {
      warnings.push(`Step ${step.number} had a response too large to keep in full, so links to later steps may be missing.`);
    }
  }
  const sockets = records.filter((record) => record.resourceType === 'websocket').length;
  if (sockets) warnings.push(`${sockets} WebSocket connection${sockets > 1 ? 's were' : ' was'} skipped. Scripts can only replay HTTP requests.`);

  const disabled = allLinks
    .filter((link) => disabledLinks.has(linkKey(link)))
    .map((link) => ({ key: linkKey(link), where: describeSlot(link.slot), from: describeSource(link.source) }));

  return {
    scriptName: slug(scriptName) || 'api_script',
    embedSecrets,
    keepBrowserHeaders,
    steps,
    seedCookies,
    flows: [...flows.values()],
    disabled,
    config: [...config.values()],
    warnings: [...new Set(warnings)],
    hosts: [...new Set(steps.map((step) => hostOf(step.record.url)))],
    collapsed: included.length - steps.length,
    now,
  };
}
