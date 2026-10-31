// A language-neutral description of each request in a plan. Renderers turn
// these parts into source code, each with its own quoting rules.
import { isConditionalHeader, replayHeaders } from './curl.js';
import { commentSafe } from './shell.js';
import { parseBody, parseUrl, slotsOf, walkJson } from './slots.js';

export const lit = (text) => ({ lit: text });
export const ref = (name, encode = false) => ({ ref: name, encode });

// Replaces captured secrets that sit inside otherwise harmless text, such as a
// token in the query string of a Referer header.
export function scrubParts(parts, config) {
  let result = parts;
  for (const { name, value } of config) {
    if (value.length < 6) continue;
    result = result.flatMap((part) => {
      if (part.lit === undefined || !part.lit.includes(value)) return [part];
      return part.lit.split(value).flatMap((text, index) => {
        const pieces = index === 0 ? [] : [ref(name)];
        return text ? [...pieces, lit(text)] : pieces;
      });
    });
  }
  return result;
}

export function scrubText(text, config) {
  return config.reduce((result, { name, value }) => {
    return value.length < 6 ? result : result.replaceAll(value, `{${name}}`);
  }, text);
}

export function slicedParts(value, binds, encodeLiteral = (text) => text) {
  const parts = [];
  let cursor = 0;
  for (const bind of [...binds].sort((a, b) => a.start - b.start)) {
    if (bind.start > cursor) parts.push(lit(encodeLiteral(value.slice(cursor, bind.start))));
    parts.push(ref(bind.name, bind.encode));
    cursor = bind.end;
  }
  if (cursor < value.length) parts.push(lit(encodeLiteral(value.slice(cursor))));
  return parts;
}

export function urlParts(step, plan) {
  const { record, binds } = step;
  const whole = binds.get('url');
  if (whole) {
    return scrubParts(slicedParts(record.url, whole.map((bind) => ({ ...bind, encode: false }))), plan.config);
  }
  const url = parseUrl(record.url);
  const parts = [lit(url.origin)];
  for (const segment of url.segments) {
    parts.push(lit('/'));
    const bound = binds.get(segment.id);
    if (bound) parts.push(...slicedParts(segment.value, bound, encodeURIComponent));
    else parts.push(lit(segment.raw));
  }
  url.query.forEach((param, index) => {
    parts.push(lit(`${index === 0 ? '?' : '&'}${param.rawName}`));
    const bound = binds.get(param.id);
    if (bound) {
      parts.push(lit('='), ...slicedParts(param.value, bound, encodeURIComponent));
    } else if (param.rawValue || record.url.includes(`${param.rawName}=`)) {
      parts.push(lit(`=${param.rawValue}`));
    }
  });
  return scrubParts(parts, plan.config);
}

// The literal "?name=" or "&name=" for a parameter the first page left out.
export function extraQueryLiteral(step, name) {
  const joiner = step.record.url.includes('?') ? '&' : '?';
  return lit(`${joiner}${encodeURIComponent(name)}=`);
}

export function headerParts(step, plan) {
  const { record, binds } = step;
  return replayHeaders(record, { clean: !plan.keepBrowserHeaders })
    .filter(({ name }) => !isConditionalHeader(name) && name.toLowerCase() !== 'cookie')
    .map(({ name, value }) => {
      const bound = binds.get(`header:${name.toLowerCase()}`);
      const parts = bound ? slicedParts(value, bound) : [lit(value)];
      return { name, parts: scrubParts(parts, plan.config) };
    });
}

function setJsonPath(root, path, value) {
  if (!path.length) return value;
  let node = root;
  for (const token of path.slice(0, -1)) node = node[token];
  node[path.at(-1)] = value;
  return root;
}

// A JSON leaf whose value is computed when the script runs.
export class JsonValue {
  constructor(slot, binds) {
    this.path = slot.path;
    this.value = slot.value;
    this.jsonType = slot.jsonType;
    this.binds = binds;
    this.parts = slicedParts(slot.value, binds.map((bind) => ({ ...bind, encode: false })));
    this.whole = binds.length === 1 && binds[0].start === 0 && binds[0].end === slot.value.length;
    this.emptyAsNull = this.whole && Boolean(binds[0].emptyAsNull);
    this.isFloat = slot.value.includes('.');
  }

  get name() {
    return this.binds[0].name;
  }
}

function isLossless(json) {
  let lossless = true;
  walkJson(json, (leaf) => {
    if (typeof leaf === 'number' && Number.isInteger(leaf) && !Number.isSafeInteger(leaf)) lossless = false;
  });
  return lossless;
}

function jsonModel(step, body) {
  const { record, binds } = step;
  const values = slotsOf(record)
    .filter((slot) => slot.kind === 'json' && binds.has(slot.id))
    .map((slot) => new JsonValue(slot, binds.get(slot.id)));
  // Blank copies leave no captured value behind once variables replace them.
  let blanked = structuredClone(body.json);
  let tree = structuredClone(body.json);
  for (const value of values) {
    blanked = setJsonPath(blanked, value.path, value.jsonType === 'number' ? 0 : '');
    tree = setJsonPath(tree, value.path, value);
  }
  return {
    type: 'json',
    text: record.requestBody.text,
    values,
    blanked,
    tree,
    editable: values.length > 0 || isLossless(body.json),
  };
}

function formModel(step, body) {
  const { binds } = step;
  const bound = body.fields.some((field) => binds.has(field.id));
  const fields = body.fields.map((field) => {
    const fieldBinds = binds.get(field.id)?.map((bind) => ({ ...bind, encode: false }));
    return { name: field.name, parts: fieldBinds ? slicedParts(field.value, fieldBinds) : [lit(field.value)] };
  });
  return { type: 'form', text: step.record.requestBody.text, bound, fields };
}

export function bodyModel(step, plan) {
  const body = parseBody(step.record);
  if (!body) return null;
  if (body.type === 'json') return jsonModel(step, body);
  if (body.type === 'form') return formModel(step, body);
  const binds = step.binds.get('raw');
  const parts = binds ? slicedParts(body.text, binds) : [lit(body.text)];
  return { type: 'raw', parts: scrubParts(parts, plan.config) };
}

export function responseFile(step, pass) {
  return `${step.file}${pass ? `_${pass}` : ''}.${step.extension}`;
}

export function linesFile(step) {
  return `${step.file}.ndjson`;
}

// Shows the shape of the path, with {NAME} where a variable fills it in.
export function displayPath(step) {
  const shown = parseUrl(step.record.url).segments.map((segment) => {
    const binds = step.binds.get(segment.id);
    return binds ? binds.map((bind) => `{${bind.name}}`).join('') : segment.raw;
  });
  return `/${shown.join('/')}`;
}

function loopSummary(step) {
  switch (step.loop?.type) {
    case 'counter': return ' (loops through every page)';
    case 'cursor':
    case 'nextUrl': return ' (follows the next-page link)';
    case 'foreach': return ` (runs once for each ${commentSafe(step.loop.name).toLowerCase()})`;
    default: return '';
  }
}

// Comment lines for a step, without the comment marker.
export function stepComments(step, plan) {
  const path = scrubText(displayPath(step), plan.config);
  const lines = [`${commentSafe(`Step ${step.number}: ${step.record.method} ${path}`)}${loopSummary(step)}`];
  if (step.auto) lines.push('Added automatically: a later step needs a value from it.');
  return lines;
}

export function scriptDate(plan) {
  return new Date(plan.now).toISOString().slice(0, 10);
}

export function hostList(plan) {
  return plan.hosts.map(commentSafe).join(', ');
}

// Python and PowerShell read this format. Values are JSON strings, so they
// survive any character without a shell to interpret them.
export function jsonEnvFile(plan, extension) {
  if (!plan.config.length) return '';
  const lines = [
    `# Settings for ${plan.scriptName}.${extension}, captured from your browser session.`,
    '# These are live credentials. Keep this file private.',
  ];
  for (const { name, value, reason } of plan.config) {
    lines.push(`# ${commentSafe(reason)}`, `${name}=${JSON.stringify(value)}`);
  }
  return `${lines.join('\n')}\n`;
}
