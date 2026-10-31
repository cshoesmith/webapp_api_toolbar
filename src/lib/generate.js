// Turns recorded requests into a script: the plan decides what happens, the
// template sets the shape, and the dialect handles quoting.
import { bash } from './dialects/bash.js';
import { powershell } from './dialects/powershell.js';
import { python } from './dialects/python.js';
import { buildPlan } from './plan.js';
import {
  extraQueryLiteral,
  hostList,
  linesFile,
  ref,
  responseFile,
  scriptDate,
  stepComments,
  urlParts,
} from './request-model.js';
import { neededHelpers, parseTemplate, renderSnippet, renderTemplate } from './template-engine.js';

export const LANGUAGES = [bash, python, powershell];

const templates = new Map();

async function readTemplate(file) {
  const url = new URL(`../templates/${file}`, import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return readFile(url, 'utf8');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load template ${file}.`);
  return response.text();
}

export async function loadTemplates() {
  await Promise.all(LANGUAGES.map(async (language) => {
    templates.set(language.id, parseTemplate(await readTemplate(language.template)));
  }));
}

function languageById(id) {
  const language = LANGUAGES.find((item) => item.id === id);
  if (!language) throw new Error(`Unknown script language: ${id}`);
  return language;
}

function createRenderer(plan, language) {
  const template = templates.get(language.id);
  if (!template) throw new Error('Templates are not loaded yet.');
  const dialect = language.create(plan);

  const requestBlock = (step, file, url) => renderSnippet(template, 'request', {
    file,
    url,
    method: dialect.string(step.record.method),
    ...dialect.request(step),
  });

  const loopValues = (step) => {
    const { loop } = step;
    const values = {
      output: dialect.filePath(linesFile(step)),
      capture_first: step.extracts.length > 0,
    };
    const passFile = dialect.passFile(step);
    const items = loop.items ? dialect.itemValues(loop.items) : {};
    switch (loop.type) {
      case 'counter': {
        const url = urlParts(step, plan);
        if (loop.extraQuery) url.push(extraQueryLiteral(step, loop.extraQuery.name), ref(loop.name));
        return {
          ...values,
          ...items,
          var: loop.name,
          start: loop.start,
          step: loop.step,
          limit: loop.items ? dialect.maxPages : loop.recorded,
          has_items: Boolean(loop.items),
          request: requestBlock(step, passFile, dialect.parts(url)),
        };
      }
      case 'cursor': {
        const url = dialect.parts(urlParts(step, plan));
        const extra = loop.extraQuery;
        return {
          ...values,
          ...items,
          var: loop.name,
          initial: dialect.string(loop.initial),
          has_items: Boolean(loop.items),
          has_extra_query: Boolean(extra),
          base_url: url,
          extra_query: extra ? dialect.parts([extraQueryLiteral(step, extra.name), ref(loop.name, true)]) : '',
          next_value: dialect.nextValue(loop.source),
          request: requestBlock(step, passFile, extra ? dialect.urlVariable : url),
        };
      }
      case 'nextUrl':
        return {
          ...values,
          ...items,
          first_url: dialect.parts(urlParts(step, plan)),
          next_url: dialect.nextUrl(loop.prefix),
          has_items: Boolean(loop.items),
          next_value: dialect.nextValue(loop.source),
          request: requestBlock(step, passFile, dialect.urlVariable),
        };
      default:
        return {
          ...values,
          var: loop.name,
          values: dialect.foreachValues(loop),
          is_json: /json/.test(step.record.mimeType),
          request: requestBlock(step, passFile, dialect.parts(urlParts(step, plan))),
        };
    }
  };

  const LOOP_SNIPPETS = {
    counter: 'counter_loop',
    cursor: 'cursor_loop',
    nextUrl: 'next_url_loop',
    foreach: 'foreach_loop',
  };

  const renderStep = (step) => {
    const blocks = [stepComments(step, plan).map((line) => `# ${line}`).join('\n')];
    if (step.loop) {
      blocks.push(renderSnippet(template, LOOP_SNIPPETS[step.loop.type], loopValues(step)));
    } else {
      const file = dialect.string(responseFile(step));
      blocks.push(requestBlock(step, file, dialect.parts(urlParts(step, plan))));
    }
    for (const { name, source } of step.extracts) {
      blocks.push(renderSnippet(template, 'extract', { var: name, value: dialect.extract(step, source) }));
    }
    return blocks.join('\n');
  };

  return { template, dialect, renderStep };
}

export function renderScript(plan, languageId = 'bash') {
  const language = languageById(languageId);
  const { template, dialect, renderStep } = createRenderer(plan, language);
  const steps = plan.steps.map(renderStep).join('\n\n');
  const settings = dialect.settings();
  const seedCookies = dialect.seedCookies();
  const keep = neededHelpers(template, `${steps}\n${settings}\n${seedCookies}`);
  return renderTemplate(template, {
    script_name: plan.scriptName,
    date: scriptDate(plan),
    hosts: hostList(plan),
    has_loops: plan.steps.some((step) => step.loop),
    has_settings: plan.config.length > 0,
    settings,
    seed_cookies: seedCookies,
    steps,
    ...dialect.scriptValues(`${steps}\n${[...keep].map((helper) => helper.name).join(' ')}`),
  }, keep);
}

// Anything still in the script after substitution would leak when it is shared.
function leakedSecrets(plan, script) {
  if (plan.embedSecrets) return [];
  return plan.config
    .filter(({ value }) => value.length >= 6 && script.includes(value))
    .map(({ name }) => name);
}

export function generate(records, options = {}) {
  const language = languageById(options.language ?? 'bash');
  const plan = buildPlan(records, options);
  const script = renderScript(plan, language.id);
  const leaked = leakedSecrets(plan, script);
  if (leaked.length) {
    plan.warnings.push(`Check before sharing: the script still contains the value of ${leaked.join(', ')}.`);
  }
  return {
    plan,
    script,
    env: plan.embedSecrets ? '' : language.envFile(plan),
    extension: language.extension,
    byteOrderMark: language.byteOrderMark ?? false,
  };
}
