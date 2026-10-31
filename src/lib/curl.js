// Turns a record into a curl command.
import { shellQuote } from './shell.js';
import { redactBody, redactHeader, redactUrl } from './secrets.js';

// Headers curl sets itself, or that only describe the browser's transport.
const TRANSPORT_HEADER = /^(:.*|host|connection|content-length|accept-encoding|transfer-encoding|keep-alive|upgrade)$/i;
// Headers a browser adds that almost no server needs to see replayed.
const BROWSER_HEADER = /^(sec-.*|priority|dnt|upgrade-insecure-requests|pragma|cache-control)$/i;
// Replaying these turns a 200 with a body into an empty 304.
const CONDITIONAL_HEADER = /^(if-none-match|if-modified-since|if-match|if-unmodified-since|if-range)$/i;

export function isConditionalHeader(name) {
  return CONDITIONAL_HEADER.test(name);
}

export function replayHeaders(record, { clean = true } = {}) {
  return record.requestHeaders.filter(({ name }) => {
    if (TRANSPORT_HEADER.test(name)) return false;
    if (clean && (BROWSER_HEADER.test(name) || CONDITIONAL_HEADER.test(name))) return false;
    return true;
  });
}

function bodyFlag(text) {
  return `--data-raw ${shellQuote(text)}`;
}

// Multipart payloads that carried a file reach DevTools without the file bytes.
export function hasOmittedUpload(record) {
  const body = record.requestBody;
  if (!/multipart\//i.test(body?.mimeType ?? '')) return false;
  return /filename=/i.test(body.text) || body.text === '';
}

export function toCurl(record, { clean = true, redact = false } = {}) {
  const url = redact ? redactUrl(record.url) : record.url;
  const parts = [`curl ${shellQuote(url)}`];
  const bodyText = record.requestBody?.text ?? null;
  if (record.method === 'HEAD') {
    parts.push('-I');
  } else if (record.method !== (bodyText === null ? 'GET' : 'POST')) {
    parts.push(`-X ${shellQuote(record.method)}`);
  }
  let cookies = null;
  for (const { name, value } of replayHeaders(record, { clean })) {
    const safeValue = redact ? redactHeader(name, value) : value;
    if (/^cookie$/i.test(name)) cookies = safeValue;
    else parts.push(`-H ${shellQuote(`${name}: ${safeValue}`)}`);
  }
  if (cookies !== null) parts.push(`-b ${shellQuote(cookies)}`);
  if (bodyText !== null) {
    const safeBody = redact ? redactBody(bodyText, record.requestBody.mimeType) : bodyText;
    parts.push(bodyFlag(safeBody));
  }
  parts.push('--compressed');
  const command = parts.join(' \\\n  ');
  return hasOmittedUpload(record)
    ? `# Warning: Chrome does not expose uploaded file bytes, so this body is incomplete.\n${command}`
    : command;
}

export function toCurlList(records, options) {
  return records.map((record) => toCurl(record, options)).join('\n\n');
}
