// Spots credentials so they can be redacted or moved out of generated scripts.

const SECRET_HEADER = /^(authorization|proxy-authorization|x-amz-security-token)$|token|secret|api-?key|apikey|session|csrf|xsrf|auth/i;
const SECRET_PARAM = /^(key|sig|signature|auth|code)$|pass(word|wd|phrase)?$|pwd$|secret|token|api_?key|apikey|otp|pin$|credential|session/i;
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
const AUTH_SCHEME = /^(Bearer|Token|JWT)\s+(.+)$/i;

export const REDACTED = 'REDACTED';

export function isSecretHeader(name) {
  return SECRET_HEADER.test(name);
}

export function isSecretParam(name) {
  return SECRET_PARAM.test(name);
}

export function isJwt(value) {
  return JWT.test(value);
}

// Splits "Bearer abc" so only the token moves into a variable.
export function splitAuthScheme(value) {
  const match = AUTH_SCHEME.exec(value);
  if (!match) return { prefix: '', token: value, scheme: null };
  return {
    prefix: value.slice(0, value.length - match[2].length),
    token: match[2],
    scheme: match[1].toLowerCase(),
  };
}

// Returns the expiry of a JWT as epoch milliseconds, or null.
export function jwtExpiry(value) {
  if (!isJwt(value)) return null;
  try {
    const payload = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload));
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function redactCookies(value) {
  return value
    .split(';')
    .map((pair) => {
      const index = pair.indexOf('=');
      return index === -1 ? pair : `${pair.slice(0, index + 1)}${REDACTED}`;
    })
    .join(';');
}

function redactHeaderValue(value) {
  const { prefix, scheme } = splitAuthScheme(value);
  return scheme ? `${prefix}${REDACTED}` : REDACTED;
}

export function redactHeader(name, value) {
  if (/^cookie$/i.test(name)) return redactCookies(value);
  if (/^set-cookie$/i.test(name)) return REDACTED;
  if (isSecretHeader(name) || isJwt(value)) return redactHeaderValue(value);
  return value;
}

export function redactUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const secretKeys = [...parsed.searchParams]
    .filter(([key, value]) => isSecretParam(key) || isJwt(value))
    .map(([key]) => key);
  for (const key of secretKeys) parsed.searchParams.set(key, REDACTED);
  return parsed.href;
}

function redactJsonNode(node, key) {
  if (Array.isArray(node)) return node.map((item) => redactJsonNode(item, key));
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([childKey, value]) => [childKey, redactJsonNode(value, childKey)]),
    );
  }
  if (typeof node === 'string' && (isJwt(node) || (key && isSecretParam(key)))) return REDACTED;
  return node;
}

export function redactBody(text, mimeType = '') {
  if (/json/i.test(mimeType)) {
    try {
      return JSON.stringify(redactJsonNode(JSON.parse(text)));
    } catch {
      return REDACTED;
    }
  }
  if (/form-urlencoded/i.test(mimeType)) {
    const params = new URLSearchParams(text);
    for (const key of new Set(params.keys())) {
      if (isSecretParam(key)) params.set(key, REDACTED);
    }
    return params.toString();
  }
  return text;
}
