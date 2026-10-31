// How bash spells the values a template needs.
import { bodyModel, headerParts, linesFile, lit, responseFile } from '../request-model.js';
import { commentSafe, escapeDouble, shellQuote } from '../shell.js';
import { jqPath } from '../slots.js';

function parts(list) {
  if (list.every((part) => part.lit !== undefined)) {
    return shellQuote(list.map((part) => part.lit).join(''));
  }
  const body = list.map((part) => {
    if (part.lit !== undefined) {
      // Control characters leave the double quotes so nothing spans lines.
      return escapeDouble(part.lit).replace(/[\x01-\x1f\x7f]/g, (ch) => `"${shellQuote(ch)}"`);
    }
    return part.encode ? `$(urlencode "$${part.ref}")` : `\${${part.ref}}`;
  }).join('');
  return `"${body}"`;
}

function jsonAssignment(value, args) {
  const argFor = (bind) => {
    const name = `a${args.length}`;
    args.push(`--arg ${name} "$${bind.name}"`);
    return `$${name}`;
  };
  const target = jqPath(value.path);
  if (value.whole) {
    const arg = argFor(value.binds[0]);
    if (value.emptyAsNull) return `${target} = (if ${arg} == "" then null else ${arg} end)`;
    return `${target} = ${value.jsonType === 'number' ? `(${arg} | tonumber)` : arg}`;
  }
  const pieces = [];
  let cursor = 0;
  for (const bind of [...value.binds].sort((a, b) => a.start - b.start)) {
    if (bind.start > cursor) pieces.push(JSON.stringify(value.value.slice(cursor, bind.start)));
    pieces.push(argFor(bind));
    cursor = bind.end;
  }
  if (cursor < value.value.length) pieces.push(JSON.stringify(value.value.slice(cursor)));
  return `${target} = ${pieces.join(' + ')}`;
}

// Native curl on Windows reads its arguments in the system code page, which
// garbles anything outside ASCII, so those bodies travel through a file instead.
function literalBody(expression, text) {
  if (/^[\x00-\x7f]*$/.test(text)) return { before: '', args: [`--data-raw ${expression}`] };
  return {
    before: `printf '%s' ${expression} > "$OUT_DIR/request_body"`,
    args: ['--data-binary "@$OUT_DIR/request_body"'],
  };
}

function jsonBody(model) {
  if (!model.values.length) return literalBody(shellQuote(model.text), model.text);
  const args = [];
  const filter = model.values.map((value) => jsonAssignment(value, args)).join(' | ');
  const call = `json_set ${shellQuote(JSON.stringify(model.blanked))} ${shellQuote(filter)} ${args.join(' ')}`;
  return { before: `BODY=$(${call})`, args: ['--data-raw "$BODY"'] };
}

function encodeField(field) {
  const encoded = field.parts.map((part) => {
    return part.lit === undefined ? { ...part, encode: true } : lit(encodeURIComponent(part.lit));
  });
  return [lit(`${encodeURIComponent(field.name)}=`), ...encoded];
}

function formBody(model) {
  if (!model.bound) return literalBody(shellQuote(model.text), model.text);
  const fields = model.fields.flatMap((field, index) => [...(index ? [lit('&')] : []), ...encodeField(field)]);
  return { before: '', args: [`--data-raw ${parts(fields)}`] };
}

function body(model) {
  if (!model) return { before: '', args: [] };
  if (model.type === 'json') return jsonBody(model);
  if (model.type === 'form') return formBody(model);
  const text = model.parts.map((part) => part.lit ?? '').join('');
  return literalBody(parts(model.parts), text);
}

function strictValue(source, files) {
  switch (source.kind) {
    case 'json':
      return `jget ${files.body} ${shellQuote(jqPath(source.path))}`;
    case 'jsonUrlParam':
      return `url_param "$(jget ${files.body} ${shellQuote(jqPath(source.path))})" ${shellQuote(source.param)}`;
    case 'header':
      return `hget ${files.headers} ${shellQuote(source.name)}`;
    case 'headerUrlParam':
      return `url_param "$(hget ${files.headers} ${shellQuote(source.name)})" ${shellQuote(source.param)}`;
    case 'cookie':
      return `jar_get ${shellQuote(source.name)}`;
    default:
      return `between ${files.body} ${shellQuote(source.prefix)} ${shellQuote(source.suffix)}`;
  }
}

// The end of the results shows up as a null or missing field, which is normal
// for a next-page value, so this never stops the script.
function softValue(source) {
  const json = () => `jq -r ${shellQuote(`${jqPath(source.path)} // empty`)} "$RESP" | tr -d '\\r'`;
  const header = () => `header_value "$RESP_HEADERS" ${shellQuote(source.name)}`;
  switch (source.kind) {
    case 'json': return json();
    case 'header': return header();
    case 'jsonUrlParam': return `url_param "$(${json()})" ${shellQuote(source.param)}`;
    default: return `url_param "$(${header()})" ${shellQuote(source.param)}`;
  }
}

function withDecoding(expression, source) {
  return source.decode ? `urldecode "$(${expression})"` : expression;
}

function envFile(plan) {
  if (!plan.config.length) return '';
  const lines = [
    `# Settings for ${plan.scriptName}.sh, captured from your browser session.`,
    '# These are live credentials. Keep this file private.',
  ];
  for (const { name, value, reason } of plan.config) {
    lines.push(`# ${commentSafe(reason)}`, `${name}=${shellQuote(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function create(plan) {
  return {
    string: shellQuote,
    parts,
    maxPages: 'MAX_PAGES',
    urlVariable: '"$URL"',
    filePath: (name) => `"$OUT_DIR/${name}"`,
    passFile: (step) => `"${step.file}_\${pass}.${step.extension}"`,

    request(step) {
      const { before, args } = body(bodyModel(step, plan));
      const options = headerParts(step, plan).map(({ name, parts: value }) => {
        return `-H ${parts([lit(`${name}: `), ...value])}`;
      });
      options.push(...args);
      return {
        before,
        options: options.map((option) => ` \\\n  ${option}`).join(''),
        error_prefix: step.record.status >= 400 ? 'ALLOW_ERROR=1 ' : '',
      };
    },

    extract(step, source) {
      const files = step.group
        ? {
          body: `"$OUT_DIR/${responseFile(step, 1)}"`,
          headers: `"$OUT_DIR/headers/${responseFile(step, 1)}.txt"`,
        }
        : { body: '"$RESP"', headers: '"$RESP_HEADERS"' };
      return withDecoding(strictValue(source, files), source);
    },

    nextValue: (source) => withDecoding(softValue(source), source),
    nextUrl: (prefix) => parts([lit(prefix), { ref: 'NEXT', encode: false }]),

    itemValues(items) {
      const path = items.length ? `(${jqPath(items)} // [])` : '.';
      return {
        count_filter: shellQuote(`${path} | length`),
        items_filter: shellQuote(items.length ? `${jqPath(items)}[]` : '.[]'),
      };
    },

    foreachValues(loop) {
      const { filter, file } = loop.pages
        ? { filter: jqPath(loop.pages.itemPath), file: linesFile(loop.pagedStep) }
        : {
          filter: jqPath(loop.iterate),
          file: responseFile(loop.sourceStep, loop.sourceStep.group ? 1 : 0),
        };
      return `jq -r ${shellQuote(filter)} "$OUT_DIR/${file}" | tr -d '\\r' | head -n "$MAX_ITEMS"`;
    },

    seedCookies() {
      return plan.seedCookies
        .map(({ hostname, name }) => `seed_cookies ${shellQuote(hostname)} "$${name}"`)
        .join('\n');
    },

    settings() {
      if (!plan.config.length) return '';
      const lines = ['# Values captured from your browser session.'];
      if (plan.embedSecrets) {
        for (const { name, value, reason } of plan.config) {
          lines.push(`# ${commentSafe(reason)}`, `${name}=\${${name}:-${shellQuote(value)}}`);
        }
        return lines.join('\n');
      }
      for (const { name, reason } of plan.config) lines.push(`# ${name}: ${commentSafe(reason)}`);
      lines.push(
        'missing=""',
        `for name in ${plan.config.map(({ name }) => name).join(' ')}; do`,
        '  if [[ -z ${!name:-} ]]; then missing+=" $name"; fi',
        'done',
        'if [[ -n $missing ]]; then',
        '  echo "Set these before running, in the environment or in $ENV_FILE:$missing" >&2',
        '  exit 1',
        'fi',
      );
      return lines.join('\n');
    },

    scriptValues(code) {
      const usesJq = /(^|[\s($])jq\s/m.test(code) || /jget|collect|json_set|urlencode/.test(code);
      return { tools: usesJq ? 'curl jq' : 'curl' };
    },
  };
}

export const bash = {
  id: 'bash',
  label: 'Bash',
  extension: 'sh',
  template: 'bash.sh',
  create,
  envFile,
};
