// How PowerShell spells the values a template needs.
import {
  bodyModel,
  headerParts,
  jsonEnvFile,
  JsonValue,
  linesFile,
  responseFile,
} from '../request-model.js';
import { commentSafe } from '../shell.js';

// PowerShell treats curly quotes as real quotes, so a captured apostrophe in
// either form would end a string early. Both sets are escaped everywhere.
const SINGLE_QUOTES = /['‘’‚‛]/g;
const DOUBLE_SPECIALS = /[`$"“”„]/g;
const CONTROL = /[\x00-\x1f\x7f]/;
const CONTROL_ALL = /[\x00-\x1f\x7f]/g;
const CONTROL_NAMES = { '\n': '`n', '\r': '`r', '\t': '`t' };

function escapeDouble(text) {
  return String(text)
    .replaceAll('\0', '')
    .replace(DOUBLE_SPECIALS, '`$&')
    .replace(CONTROL_ALL, (ch) => {
      return CONTROL_NAMES[ch] ?? `$([char]0x${ch.charCodeAt(0).toString(16).padStart(2, '0')})`;
    });
}

function string(value) {
  const text = String(value);
  if (CONTROL.test(text)) return `"${escapeDouble(text)}"`;
  return `'${text.replace(SINGLE_QUOTES, '$&$&')}'`;
}

function parts(list) {
  if (list.every((part) => part.lit !== undefined)) return string(list.map((part) => part.lit).join(''));
  const body = list.map((part) => {
    if (part.lit !== undefined) return escapeDouble(part.lit);
    return part.encode ? `$([uri]::EscapeDataString($${part.ref}))` : `\${${part.ref}}`;
  }).join('');
  return `"${body}"`;
}

function jsonValue(value) {
  if (value.emptyAsNull) return `$(if ($${value.name}) { $${value.name} } else { $null })`;
  if (!value.whole) return parts(value.parts);
  if (value.jsonType === 'number') return `[${value.isFloat ? 'double' : 'long'}]$${value.name}`;
  return `[string]$${value.name}`;
}

function literal(node) {
  if (node instanceof JsonValue) return jsonValue(node);
  if (node === null) return '$null';
  if (node === true) return '$true';
  if (node === false) return '$false';
  if (typeof node === 'string') return string(node);
  if (Array.isArray(node)) {
    // A lone inner array would otherwise be flattened into the outer one.
    const lead = node.length === 1 && Array.isArray(node[0]) ? ',' : '';
    return `@(${lead}${node.map(literal).join(', ')})`;
  }
  if (typeof node === 'object') {
    const entries = Object.entries(node).map(([key, value]) => `${string(key)} = ${literal(value)}`);
    return `[ordered]@{ ${entries.join('; ')} }`;
  }
  return String(node);
}

function memberPath(tokens) {
  return tokens.map((token) => {
    if (typeof token === 'number') return `[${token}]`;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ? `.${token}` : `.${string(token)}`;
  }).join('');
}

// Root arrays lose their array-ness when piped, so @() restores it first.
function jsonPath(reader, tokens) {
  return typeof tokens[0] === 'number'
    ? `@(${reader})${memberPath(tokens)}`
    : `(${reader})${memberPath(tokens)}`;
}

function requestBody(model) {
  if (!model) return { before: '', option: '' };
  if (model.type === 'json') {
    if (!model.editable) return { before: '', option: ` -Body ${string(model.text)}` };
    const tree = literal(model.tree);
    return {
      before: `$requestBody = ConvertTo-Json -Depth 64 -Compress -InputObject (${tree})`,
      option: ' -Body $requestBody',
    };
  }
  if (model.type === 'form') {
    if (!model.bound) return { before: '', option: ` -Body ${string(model.text)}` };
    const fields = model.fields.flatMap((field) => [string(field.name), parts(field.parts)]);
    return { before: '', option: ` -Body (Format-Form @(${fields.join(', ')}))` };
  }
  return { before: '', option: ` -Body ${parts(model.parts)}` };
}

function strictValue(source, response) {
  const json = () => {
    const expression = jsonPath(`Read-Json ${response}`, source.path);
    return `Get-Required (${expression}) ${string(source.path.join('.'))}`;
  };
  const header = () => `Get-Required (${response}.Headers[${string(source.name)}]) ${string(`header ${source.name}`)}`;
  switch (source.kind) {
    case 'json': return json();
    case 'jsonUrlParam': return `Get-UrlParam (${json()}) ${string(source.param)}`;
    case 'header': return header();
    case 'headerUrlParam': return `Get-UrlParam (${header()}) ${string(source.param)}`;
    case 'cookie': {
      const cookie = `Get-Required (Get-JarCookie ${response}.Url ${string(source.name)}) ${string(`cookie ${source.name}`)}`;
      return source.decode ? `[uri]::UnescapeDataString((${cookie}))` : cookie;
    }
    default:
      return `Get-Between ${response}.Text ${string(source.prefix)} ${string(source.suffix)}`;
  }
}

function softValue(source) {
  const json = () => `[string](${jsonPath('Read-Json $Resp', source.path)})`;
  const header = () => `[string]($Resp.Headers[${string(source.name)}])`;
  switch (source.kind) {
    case 'json': return json();
    case 'header': return header();
    case 'jsonUrlParam': return `Get-UrlParam (${json()}) ${string(source.param)}`;
    default: return `Get-UrlParam (${header()}) ${string(source.param)}`;
  }
}

function create(plan) {
  return {
    string,
    parts,
    maxPages: '$MaxPages',
    urlVariable: '$requestUrl',
    filePath: (name) => `(Join-Path $OutDir ${string(name)})`,
    passFile: (step) => `"${step.file}_\${pageNumber}.${step.extension}"`,

    request(step) {
      const { before, option } = requestBody(bodyModel(step, plan));
      let options = '';
      const headers = headerParts(step, plan);
      if (headers.length) {
        const lines = headers.map(({ name, parts: value }) => `    ${string(name)} = ${parts(value)}`);
        options += ` -Headers ([ordered]@{\n${lines.join('\n')}\n})`;
      }
      options += option;
      if (step.record.status >= 400) options += ' -AllowError';
      return { before, options };
    },

    extract: (step, source) => strictValue(source, step.group ? '$first' : '$Resp'),
    nextValue: softValue,
    nextUrl: (prefix) => parts([{ lit: prefix }, { ref: 'nextValue', encode: false }]),
    itemValues: (items) => ({
      items: items.length ? `Select-Items ${jsonPath('Read-Json $Resp', items)}` : 'Select-Items (Read-Json $Resp)',
    }),

    foreachValues(loop) {
      if (loop.pages) {
        const read = `Read-Lines ${string(linesFile(loop.pagedStep))}`;
        return `${read} | ForEach-Object { $_${memberPath(loop.pages.itemPath)} }`;
      }
      const wildcard = loop.iterate.indexOf(null);
      const list = loop.iterate.slice(0, wildcard);
      const rest = loop.iterate.slice(wildcard + 1);
      const file = responseFile(loop.sourceStep, loop.sourceStep.group ? 1 : 0);
      const read = `Read-JsonFile ${string(file)}`;
      const source = list.length ? jsonPath(read, list) : `@(${read})`;
      return `${source} | ForEach-Object { $_${memberPath(rest)} }`;
    },

    seedCookies() {
      return plan.seedCookies
        .map(({ origin, name }) => `Add-BrowserCookies -Url ${string(origin)} -Text $${name}`)
        .join('\n');
    },

    settings() {
      if (!plan.config.length) return '';
      const lines = ['# Values captured from your browser session.'];
      for (const { name, value, reason } of plan.config) {
        lines.push(`# ${commentSafe(reason)}`);
        lines.push(plan.embedSecrets
          ? `$${name} = if ($env:${name}) { $env:${name} } else { ${string(value)} }`
          : `$${name} = $env:${name}`);
      }
      if (!plan.embedSecrets) {
        const names = plan.config.map(({ name }) => string(name)).join(', ');
        lines.push(
          `$missing = @(${names}) | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }`,
          'if ($missing) {',
          '    throw "Set these before running, in the environment or in ${EnvFile}: $($missing -join \', \')"',
          '}',
        );
      }
      return lines.join('\n');
    },

    scriptValues: () => ({}),
  };
}

export const powershell = {
  id: 'powershell',
  label: 'PowerShell',
  extension: 'ps1',
  template: 'powershell.ps1',
  // Windows PowerShell 5.1 reads BOM-less files in the system code page.
  byteOrderMark: true,
  create,
  envFile: (plan) => jsonEnvFile(plan, 'ps1'),
};
