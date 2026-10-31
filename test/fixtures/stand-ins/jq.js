// A stand-in for jq covering only the filters generated scripts use, so bash
// scripts can be run on a machine without jq. Real jq is used when installed.
// Like jq.exe on Windows it ends lines with CRLF, because scripts must cope.
import { readFileSync } from 'node:fs';

const EOL = process.platform === 'win32' ? '\r\n' : '\n';
const args = process.argv.slice(2);
const named = {};
const positional = [];
let raw = false;
let compact = false;
let noInput = false;
let ascii = false;

while (args.length) {
  const arg = args.shift();
  if (arg === '--arg') {
    const name = args.shift();
    named[name] = args.shift();
  } else if (/^-[rcna]+$/.test(arg)) {
    raw ||= arg.includes('r');
    compact ||= arg.includes('c');
    noInput ||= arg.includes('n');
    ascii ||= arg.includes('a');
  } else {
    positional.push(arg);
  }
}
const [filter, file] = positional;

function parsePath(text) {
  const tokens = [];
  let rest = text.trim();
  if (rest === '.') return tokens;
  if (!rest.startsWith('.')) throw new Error(`Unsupported path: ${text}`);
  rest = rest.slice(1);
  while (rest) {
    let match;
    if ((match = /^\.?\[\]/.exec(rest))) {
      tokens.push(null);
    } else if ((match = /^\.?\[(\d+)\]/.exec(rest))) {
      tokens.push(Number(match[1]));
    } else if ((match = /^\.?\[("(?:[^"\\]|\\.)*")\]/.exec(rest))) {
      tokens.push(JSON.parse(match[1]));
    } else if ((match = /^\.?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) {
      tokens.push(match[1]);
    } else {
      throw new Error(`Unsupported path: ${text}`);
    }
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

function select(nodes, tokens) {
  return tokens.reduce((current, token) => current.flatMap((node) => {
    if (token === null) return Array.isArray(node) ? node : [];
    return [node === null || node === undefined ? null : node[token] ?? null];
  }), nodes);
}

function setPath(root, tokens, value) {
  if (!tokens.length) return value;
  let node = root;
  for (const token of tokens.slice(0, -1)) node = node[token];
  node[tokens.at(-1)] = value;
  return root;
}

function uri(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function evaluateAssigned(text) {
  const expression = text.trim();
  let match;
  if ((match = /^\(if (\$\w+) == "" then null else \1 end\)$/.exec(expression))) {
    const value = named[match[1].slice(1)];
    return value === '' ? null : value;
  }
  if ((match = /^\((\$\w+) \| tonumber\)$/.exec(expression))) return Number(named[match[1].slice(1)]);
  const pieces = expression.match(/"(?:[^"\\]|\\.)*"|\$\w+/g);
  return pieces.map((piece) => (piece.startsWith('$') ? named[piece.slice(1)] : JSON.parse(piece))).join('');
}

// Splits on " | " outside of strings and brackets.
function splitPipes(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (ch === '\\') index += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === '|' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function run(input) {
  if (filter === '$value | @uri') return [uri(named.value)];
  const parts = splitPipes(filter);
  if (parts.length && parts.every((part) => / = /.test(part) && part.startsWith('.'))) {
    let output = input;
    for (const part of parts) {
      const split = part.indexOf(' = ');
      output = setPath(output, parsePath(part.slice(0, split)), evaluateAssigned(part.slice(split + 3)));
    }
    return [output];
  }
  if (parts.length === 2 && parts[1] === 'length') {
    const inner = parts[0].replace(/^\(|\/\/ \[\]\)$/g, '').trim();
    const [value] = select([input], parsePath(inner));
    return [value?.length ?? 0];
  }
  const fallback = /^(.*) \/\/ empty$/.exec(filter);
  if (fallback) {
    return select([input], parsePath(fallback[1])).filter((value) => value !== null && value !== false);
  }
  return select([input], parsePath(filter));
}

// Files of JSON lines hold many documents, and jq runs the filter on each one.
function readDocuments() {
  if (noInput) return [null];
  const text = readFileSync(file ?? 0, 'utf8');
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

function serialize(value) {
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  if (!ascii) return json;
  return json.replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const output = readDocuments().flatMap(run).map((value) => {
  return raw && typeof value === 'string' ? value : serialize(value);
});
if (output.length) process.stdout.write(`${output.join(EOL)}${EOL}`);
