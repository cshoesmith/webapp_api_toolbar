// How Python spells the values a template needs.
import {
  bodyModel,
  headerParts,
  jsonEnvFile,
  JsonValue,
  linesFile,
  responseFile,
} from '../request-model.js';
import { commentSafe } from '../shell.js';

// A JSON string is also a valid Python string, including all of its escapes.
function string(text) {
  return JSON.stringify(String(text).replaceAll('\0', ''));
}

// f-strings run whatever is inside {braces}, so braces in captured text must be
// doubled or a hostile URL becomes code.
function parts(list) {
  if (list.every((part) => part.lit !== undefined)) return string(list.map((part) => part.lit).join(''));
  const body = list.map((part) => {
    if (part.lit !== undefined) return string(part.lit).slice(1, -1).replace(/[{}]/g, '$&$&');
    return part.encode ? `{enc(${part.ref})}` : `{${part.ref}}`;
  }).join('');
  return `f"${body}"`;
}

function jsonValue(value) {
  if (value.emptyAsNull) return `${value.name} or None`;
  if (!value.whole) return parts(value.parts);
  if (value.jsonType === 'number') return `${value.isFloat ? 'float' : 'int'}(${value.name})`;
  return `str(${value.name})`;
}

function literal(node) {
  if (node instanceof JsonValue) return jsonValue(node);
  if (node === null) return 'None';
  if (node === true) return 'True';
  if (node === false) return 'False';
  if (typeof node === 'string') return string(node);
  if (Array.isArray(node)) return `[${node.map(literal).join(', ')}]`;
  if (typeof node === 'object') {
    return `{${Object.entries(node).map(([key, value]) => `${string(key)}: ${literal(value)}`).join(', ')}}`;
  }
  return String(node);
}

function path(tokens) {
  return tokens.map((token) => (token === null ? 'None' : literal(token))).join(', ');
}

function body(model) {
  if (!model) return [];
  if (model.type === 'json') {
    return [model.editable ? `json=${literal(model.tree)}` : `data=${string(model.text)}.encode("utf-8")`];
  }
  if (model.type === 'form') {
    if (!model.bound) return [`data=${string(model.text)}.encode("utf-8")`];
    const fields = model.fields.map((field) => `(${string(field.name)}, ${parts(field.parts)})`);
    return [`data=[${fields.join(', ')}]`];
  }
  return [`data=${parts(model.parts)}.encode("utf-8")`];
}

function strictValue(source, response) {
  const json = () => `text(dig(${response}.json(), ${path(source.path)}))`;
  const header = () => `text(${response}.headers.get(${string(source.name)}))`;
  switch (source.kind) {
    case 'json': return json();
    case 'jsonUrlParam': return `url_param(${json()}, ${string(source.param)})`;
    case 'header': return header();
    case 'headerUrlParam': return `url_param(${header()}, ${string(source.param)})`;
    case 'cookie': {
      const cookie = `text(jar_cookie(${string(source.name)}))`;
      return source.decode ? `unquote(${cookie})` : cookie;
    }
    default: return `between(${response}.text, ${string(source.prefix)}, ${string(source.suffix)})`;
  }
}

function softValue(source) {
  const json = () => `dig(resp.json(), ${path(source.path)})`;
  const header = () => `resp.headers.get(${string(source.name)})`;
  switch (source.kind) {
    case 'json': return `str(${json()} or "")`;
    case 'header': return `str(${header()} or "")`;
    case 'jsonUrlParam': return `url_param(${json()} or "", ${string(source.param)})`;
    default: return `url_param(${header()} or "", ${string(source.param)})`;
  }
}

function create(plan) {
  return {
    string,
    parts,
    maxPages: 'MAX_PAGES',
    urlVariable: 'url',
    filePath: (name) => `OUT_DIR / ${string(name)}`,
    passFile: (step) => `f"${step.file}_{number}.${step.extension}"`,

    request(step) {
      const options = [];
      const headers = headerParts(step, plan);
      if (headers.length) {
        const lines = headers.map(({ name, parts: value }) => `        ${string(name)}: ${parts(value)},`);
        options.push(`headers={\n${lines.join('\n')}\n    }`);
      }
      options.push(...body(bodyModel(step, plan)));
      if (step.record.status >= 400) options.push('allow_error=True');
      return {
        before: '',
        options: options.length ? `,\n${options.map((option) => `    ${option},`).join('\n')}\n` : '',
      };
    },

    extract: (step, source) => strictValue(source, step.group ? 'first' : 'resp'),
    nextValue: softValue,
    nextUrl: (prefix) => parts([{ lit: prefix }, { ref: 'next_value', encode: false }]),
    itemValues: (items) => ({
      items: items.length ? `dig(resp.json(), ${path(items)}) or []` : 'resp.json()',
    }),

    foreachValues(loop) {
      if (loop.pages) {
        const rest = path(loop.pages.itemPath);
        return `each_line(${string(linesFile(loop.pagedStep))}${rest ? `, ${rest}` : ''})`;
      }
      const file = responseFile(loop.sourceStep, loop.sourceStep.group ? 1 : 0);
      return `each(read_json(${string(file)}), ${path(loop.iterate)})`;
    },

    seedCookies() {
      return plan.seedCookies
        .map(({ hostname, name }) => `seed_cookies(${string(hostname)}, ${name})`)
        .join('\n');
    },

    settings() {
      if (!plan.config.length) return '';
      const lines = ['# Values captured from your browser session.'];
      for (const { name, value, reason } of plan.config) {
        lines.push(`# ${commentSafe(reason)}`);
        lines.push(plan.embedSecrets
          ? `${name} = os.environ.get(${string(name)}) or ${string(value)}`
          : `${name} = os.environ.get(${string(name)}, "")`);
      }
      if (!plan.embedSecrets) {
        const names = plan.config.map(({ name }) => string(name)).join(', ');
        lines.push(
          `missing = [name for name in [${names}] if not os.environ.get(name)]`,
          'if missing:',
          '    sys.exit(f"Set these before running, in the environment or in {ENV_FILE}: {\', \'.join(missing)}")',
        );
      }
      return lines.join('\n');
    },

    scriptValues: () => ({}),
  };
}

export const python = {
  id: 'python',
  label: 'Python',
  extension: 'py',
  template: 'python.py',
  create,
  envFile: (plan) => jsonEnvFile(plan, 'py'),
};
