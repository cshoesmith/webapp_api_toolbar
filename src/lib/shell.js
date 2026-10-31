// Shell quoting. Everything captured from the network is untrusted, so every
// value that reaches a generated command goes through one of these functions.

const NEEDS_ANSI = /[\x00-\x1f\x7f]/;
const ANSI_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\', "'": "\\'" };

// Quote a literal for bash. Falls back to $'...' when the value holds control
// characters so the command survives being pasted into a terminal.
export function shellQuote(value) {
  const text = String(value);
  if (!NEEDS_ANSI.test(text)) return `'${text.replaceAll("'", `'\\''`)}'`;
  const body = text
    .replaceAll('\0', '')
    .replace(/[\\'\x01-\x1f\x7f]/g, (ch) => {
      return ANSI_ESCAPES[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    });
  return `$'${body}'`;
}

// Escape a literal for use inside a double-quoted bash string.
export function escapeDouble(value) {
  return String(value).replaceAll('\0', '').replace(/[\\"$`]/g, '\\$&');
}

// Comments must stay on one line: a captured URL must not be able to end the
// comment and start a command.
export function commentSafe(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function toVarName(value) {
  const name = String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!name) return 'VALUE';
  return /^[0-9]/.test(name) ? `V_${name}` : name;
}
