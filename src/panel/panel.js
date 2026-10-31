// The DevTools panel. Captured content is shown with textContent only, because
// response bodies and URLs come from sites that may be hostile.
import { hostOf, isApiRequest } from '../lib/classify.js';
import { correlate } from '../lib/correlate.js';
import { toCurl, toCurlList } from '../lib/curl.js';
import { generate, LANGUAGES, loadTemplates } from '../lib/generate.js';
import { applyContent, fromHar, fromHarEntry, isTextMime, toHar } from '../lib/har.js';
import { displayPath } from '../lib/request-model.js';
import { jqPath } from '../lib/slots.js';
import { createTabRecorder } from './tab-recorder.js';

const CONTENT_TIMEOUT_MS = 3000;
const MAX_STORED_CHARS = 256 * 1024 * 1024;
const LINK_REFRESH_MS = 400;
const LANGUAGE_KEY = 'api-toolbar-language';
const devtools = globalThis.chrome?.devtools ?? null;

// Without DevTools around, the panel records through chrome.debugger instead.
const tabRecorder = !devtools && globalThis.chrome?.debugger
  ? createTabRecorder({ onEntry: capture, onDetach: handleDetach })
  : null;

const state = {
  recording: Boolean(devtools),
  target: '',
  notice: '',
  records: [],
  seen: new Set(),
  nextId: 1,
  storedChars: 0,
  unticked: new Set(),
  selectedId: null,
  scope: 'api',
  host: '',
  search: '',
  tab: 'curl',
  curlClean: true,
  curlRedact: false,
  links: [],
  disabledLinks: new Set(),
  language: 'bash',
  output: null,
};

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms) {
  if (!ms) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

// DevTools panels are not granted clipboard-write, so the async clipboard API
// fails there and the older selection-based copy is tried first.
async function copyText(text, message) {
  const area = h('textarea', { value: text });
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  if (!copied) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  toast(copied ? message : 'Copy failed. Select the text and copy it by hand.');
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Capture

function trackBody(record) {
  state.storedChars += record.responseBody?.length ?? 0;
}

function wantsBody(record) {
  return state.storedChars < MAX_STORED_CHARS && (isTextMime(record.mimeType) || isApiRequest(record));
}

function addRecord(record) {
  state.records.push(record);
  scheduleRender();
  scheduleLinks();
}

function capture(entry) {
  const key = entry._key ?? `${entry.startedDateTime}|${entry.request?.method}|${entry.request?.url}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  const record = fromHarEntry(entry, state.nextId);
  state.nextId += 1;
  if (!wantsBody(record) || typeof entry.getContent !== 'function') {
    addRecord(record);
    return;
  }
  // getContent never calls back for some cancelled requests.
  let finished = false;
  const finish = (content, encoding) => {
    if (finished) return;
    finished = true;
    applyContent(record, content, encoding);
    trackBody(record);
    addRecord(record);
  };
  setTimeout(finish, CONTENT_TIMEOUT_MS);
  entry.getContent(finish);
}

// A recorder opened in its own tab is told which tab to record with ?tabId=.
async function targetTabId() {
  const requested = Number(new URLSearchParams(location.search).get('tabId'));
  if (requested) return requested;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setTarget(url) {
  try {
    state.target = new URL(url).host;
  } catch {
    state.target = '';
  }
}

async function startTabRecording() {
  state.notice = '';
  try {
    const tabId = await targetTabId();
    setTarget(await tabRecorder.start(tabId));
    state.recording = true;
  } catch (error) {
    state.recording = false;
    state.notice = `Chrome can't record this tab (${error.message}). Open a website, then press Record.`;
  }
  renderToolbar();
  renderList();
}

async function stopTabRecording() {
  state.recording = false;
  state.target = '';
  await tabRecorder.stop();
}

// Chrome ends the session if the tab closes or someone cancels the banner.
function handleDetach() {
  state.recording = false;
  state.target = '';
  renderToolbar();
  renderList();
}

async function toggleRecording() {
  if (!tabRecorder) state.recording = !state.recording;
  else if (state.recording) await stopTabRecording();
  else await startTabRecording();
  renderToolbar();
  renderList();
}

function startCapture() {
  if (tabRecorder) {
    addEventListener('pagehide', () => tabRecorder.stop());
    startTabRecording();
    return;
  }
  if (!devtools) return;
  devtools.network.onRequestFinished.addListener((entry) => {
    if (state.recording) capture(entry);
  });
  // Pick up what DevTools saw before this panel was first opened.
  devtools.network.getHAR((log) => {
    if (state.recording) log.entries.forEach(capture);
  });
}

// List

function orderedRecords() {
  return [...state.records].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

function visibleRecords() {
  const search = state.search.toLowerCase();
  return orderedRecords().filter((record) => {
    if (state.scope === 'api' && !isApiRequest(record)) return false;
    if (state.host && hostOf(record.url) !== state.host) return false;
    return !search || record.url.toLowerCase().includes(search);
  });
}

function tickedRecords() {
  return visibleRecords().filter((record) => !state.unticked.has(record.id));
}

function inputsOf(id) {
  return state.links.filter((link) => link.consumerId === id);
}

function statusClass(status) {
  if (status >= 400 || status === 0) return 'status-error';
  return status < 300 ? 'status-ok' : '';
}

function methodClass(method) {
  return method === 'GET' || method === 'HEAD' ? 'method-read' : 'method-write';
}

function selectRecord(id) {
  state.selectedId = id;
  renderList();
  renderDetail();
}

function row(record) {
  const inputs = inputsOf(record.id).length;
  const tick = h('input', {
    type: 'checkbox',
    checked: !state.unticked.has(record.id),
    ariaLabel: `Include ${record.method} ${pathOf(record.url)}`,
    onclick: (event) => event.stopPropagation(),
    onchange: (event) => {
      if (event.target.checked) state.unticked.delete(record.id);
      else state.unticked.add(record.id);
      renderCount();
    },
  });
  return h(
    'tr',
    {
      class: record.id === state.selectedId ? 'selected' : '',
      onclick: () => selectRecord(record.id),
    },
    h('td', {}, tick),
    h('td', { class: `method ${methodClass(record.method)}` }, record.method),
    h('td', { class: statusClass(record.status) }, String(record.status || 'failed')),
    h(
      'td',
      { title: record.url },
      h('span', { class: 'host' }, `${hostOf(record.url)} `),
      h('span', { class: 'path' }, pathOf(record.url)),
    ),
    h('td', { class: 'flow-count', title: 'Values taken from earlier responses' }, inputs ? String(inputs) : ''),
    h('td', { class: 'num' }, formatSize(record.responseSize)),
    h('td', { class: 'num' }, formatTime(record.time)),
  );
}

function renderHosts() {
  const select = $('host');
  const hosts = [...new Set(state.records.filter((record) => {
    return state.scope === 'all' || isApiRequest(record);
  }).map((record) => hostOf(record.url)))].sort();
  const current = hosts.includes(state.host) ? state.host : '';
  state.host = current;
  select.replaceChildren(
    h('option', { value: '' }, 'All hosts'),
    ...hosts.map((host) => h('option', { value: host }, host)),
  );
  select.value = current;
}

function renderCount() {
  const visible = visibleRecords();
  const ticked = visible.filter((record) => !state.unticked.has(record.id)).length;
  $('count').textContent = `${ticked} of ${visible.length} ticked`;
  $('tick-all').checked = visible.length > 0 && ticked === visible.length;
  $('tick-all').indeterminate = ticked > 0 && ticked < visible.length;
  for (const id of ['make-script', 'copy-all']) $(id).disabled = ticked === 0;
  $('export').disabled = state.records.length === 0;
}

function renderEmpty(visible) {
  const empty = $('empty');
  empty.hidden = visible.length > 0;
  if (visible.length > 0) return;
  if (state.notice) {
    empty.textContent = state.notice;
  } else if (state.records.length > 0) {
    empty.textContent = `${state.records.length} requests are hidden by the current filter. Choose All to see them.`;
  } else if (state.recording) {
    const reload = tabRecorder ? ' Reload the page to catch calls made while it loads.' : '';
    empty.textContent = `Waiting for traffic. Use the page, and its API calls will appear here.${reload}`;
  } else {
    empty.textContent = 'Recording is stopped. Press Record, then use the page.';
  }
}

function renderList() {
  const visible = visibleRecords();
  $('rows').replaceChildren(...visible.map(row));
  renderEmpty(visible);
  renderCount();
}

function recordLabel() {
  if (!state.recording) return 'Record';
  return tabRecorder ? 'Stop' : 'Recording';
}

function renderToolbar() {
  $('record').setAttribute('aria-pressed', String(state.recording));
  $('record-label').textContent = recordLabel();
  $('target').textContent = state.target;
  $('scope-api').setAttribute('aria-pressed', String(state.scope === 'api'));
  $('scope-all').setAttribute('aria-pressed', String(state.scope === 'all'));
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // requestAnimationFrame stops while the panel is hidden, so use a timer.
  setTimeout(() => {
    renderQueued = false;
    renderHosts();
    renderList();
  }, 60);
}

let linkTimer;
function scheduleLinks() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    state.links = correlate(state.records.filter((record) => record.status > 0));
    renderList();
    if (state.selectedId !== null && state.tab === 'flow') renderDetail();
  }, LINK_REFRESH_MS);
}

// Details

function keyValues(pairs) {
  return h('dl', { class: 'kv' }, ...pairs.flatMap(({ name, value }) => [
    h('dt', {}, name),
    h('dd', {}, value),
  ]));
}

function prettyBody(text, mimeType = '') {
  if (!/json/i.test(mimeType) && !/^\s*[{[]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function renderCurlTab(record) {
  const command = toCurl(record, { clean: state.curlClean, redact: state.curlRedact });
  const option = (label, key) => h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: state[key],
      onchange: (event) => {
        state[key] = event.target.checked;
        renderDetail();
      },
    }),
    label,
  );
  return [
    h(
      'div',
      { class: 'detail-actions' },
      h('button', { class: 'primary', onclick: () => copyText(command, 'curl command copied') }, 'Copy curl'),
      option('Hide browser-only headers', 'curlClean'),
      option('Redact credentials', 'curlRedact'),
    ),
    h('pre', { class: 'code' }, command),
  ];
}

function renderRequestTab(record) {
  const parts = [
    h('p', { class: 'section-title' }, 'URL'),
    h('pre', { class: 'code' }, `${record.method} ${record.url}`),
    h('p', { class: 'section-title' }, 'Headers'),
    keyValues(record.requestHeaders),
  ];
  if (record.requestBody) {
    parts.push(
      h('p', { class: 'section-title' }, 'Body'),
      h('pre', { class: 'code' }, prettyBody(record.requestBody.text, record.requestBody.mimeType)),
    );
  }
  return parts;
}

function renderResponseTab(record) {
  const parts = [
    h('p', { class: 'section-title' }, 'Status'),
    h('pre', { class: 'code' }, `${record.status} ${record.statusText}`),
    h('p', { class: 'section-title' }, 'Headers'),
    keyValues(record.responseHeaders),
    h('p', { class: 'section-title' }, 'Body'),
  ];
  if (record.responseBody === null) {
    parts.push(h('p', { class: 'muted' }, 'No body was captured for this request.'));
  } else if (record.responseEncoding) {
    parts.push(h('p', { class: 'muted' }, `Binary response, ${formatSize(record.responseSize)}.`));
  } else {
    if (record.truncated) parts.push(h('p', { class: 'muted' }, 'Only the first part of this body was kept.'));
    parts.push(h('pre', { class: 'code' }, prettyBody(record.responseBody, record.mimeType)));
  }
  return parts;
}

function describeLinkSource(source) {
  if (source.path) return jqPath(source.path);
  if (source.kind === 'cookie') return `cookie ${source.name}`;
  if (source.name) return `header ${source.name}`;
  return 'page text';
}

function flowButton(targetId, title, detail) {
  const target = state.records.find((record) => record.id === targetId);
  return h(
    'button',
    { class: 'flow-item', onclick: () => selectRecord(targetId) },
    h('div', {}, title),
    h('div', { class: 'muted' }, `${detail} · ${target ? `${target.method} ${pathOf(target.url)}` : ''}`),
  );
}

function renderFlowTab(record) {
  const inputs = inputsOf(record.id);
  const outputs = state.links.filter((link) => link.source.recordId === record.id);
  const parts = [h('p', { class: 'section-title' }, 'Values this request took from earlier responses')];
  if (inputs.length) {
    parts.push(...inputs.map((link) => {
      return flowButton(link.source.recordId, link.slot.key || link.slot.kind, `from ${describeLinkSource(link.source)}`);
    }));
  } else {
    parts.push(h('p', { class: 'muted' }, 'None found.'));
  }
  parts.push(h('p', { class: 'section-title' }, 'Later requests that used values from this response'));
  if (outputs.length) {
    parts.push(...outputs.map((link) => {
      return flowButton(link.consumerId, describeLinkSource(link.source), `used as ${link.slot.key || link.slot.kind}`);
    }));
  } else {
    parts.push(h('p', { class: 'muted' }, 'None found.'));
  }
  return parts;
}

const TAB_RENDERERS = {
  curl: renderCurlTab,
  request: renderRequestTab,
  response: renderResponseTab,
  flow: renderFlowTab,
};

function renderDetail() {
  const record = state.records.find((item) => item.id === state.selectedId);
  $('detail').hidden = !record;
  if (!record) return;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
  }
  $('detail-body').replaceChildren(...TAB_RENDERERS[state.tab](record));
}

// Script view

function scriptName() {
  return state.output?.plan.scriptName ?? 'api_script';
}

function loadLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (LANGUAGES.some((language) => language.id === saved)) state.language = saved;
  } catch {
    // The setting is a convenience, so a blocked store just means the default.
  }
}

function setLanguage(id) {
  state.language = id;
  try {
    localStorage.setItem(LANGUAGE_KEY, id);
  } catch {
    // See loadLanguage.
  }
  renderLanguage();
}

function renderLanguage() {
  const language = LANGUAGES.find((item) => item.id === state.language);
  $('language').value = language.id;
  $('make-script').textContent = `Make me a ${language.id === 'bash' ? 'bash' : language.label} script`;
  $('save-script').textContent = `Download .${language.extension}`;
}

function buildOutput() {
  state.output = generate(state.records, {
    language: state.language,
    selectedIds: tickedRecords().map((record) => record.id),
    disabledLinks: state.disabledLinks,
    embedSecrets: $('embed-secrets').checked,
    keepBrowserHeaders: $('keep-headers').checked,
    scriptName: $('script-name').value,
  });
  renderScript();
  renderPlan();
  $('save-env').disabled = !state.output.env;
}

function renderScript() {
  const lines = state.output.script.split('\n').map((line) => {
    const className = /^# Step \d+:/.test(line) ? 'step' : /^\s*#/.test(line) ? 'comment' : '';
    return h('span', { class: className }, `${line}\n`);
  });
  $('script').replaceChildren(...lines);
}

function stepTag(step) {
  const labels = {
    counter: 'page loop',
    cursor: 'page loop',
    nextUrl: 'page loop',
    foreach: 'for each',
  };
  if (step.loop) return h('span', { class: 'tag' }, labels[step.loop.type]);
  return step.auto ? h('span', { class: 'tag' }, 'added') : null;
}

function setFlowEnabled(keys, enabled) {
  for (const key of keys) {
    if (enabled) state.disabledLinks.delete(key);
    else state.disabledLinks.add(key);
  }
  buildOutput();
}

function flowRow(flow) {
  const keys = flow.uses.map((use) => use.key);
  const steps = [...new Set(flow.uses.map((use) => use.step))].join(', ');
  return h(
    'li',
    {},
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: true,
        onchange: (event) => setFlowEnabled(keys, event.target.checked),
      }),
      h(
        'span',
        {},
        h('code', {}, flow.name),
        h('div', { class: 'note' }, `Step ${flow.from}: ${flow.where}. Used in step ${steps}.`),
      ),
    ),
  );
}

function disabledRow(link) {
  return h(
    'li',
    {},
    h(
      'label',
      {},
      h('input', { type: 'checkbox', checked: false, onchange: () => setFlowEnabled([link.key], true) }),
      h('span', { class: 'note' }, `${link.where} keeps its recorded value, not ${link.from}.`),
    ),
  );
}

function renderPlan() {
  const { plan } = state.output;
  const section = (title, ...content) => [h('p', { class: 'section-title' }, title), ...content];
  const parts = [
    ...section(
      `Steps (${plan.steps.length})`,
      h('ul', {}, ...plan.steps.map((step) => h(
        'li',
        { class: 'step-row' },
        h('span', { class: 'step-number' }, String(step.number)),
        h(
          'span',
          {},
          h('span', { class: `method ${methodClass(step.record.method)}` }, step.record.method),
          ` ${displayPath(step)} `,
          stepTag(step),
        ),
      ))),
    ),
  ];
  if (plan.collapsed > 0) {
    parts.push(h('p', { class: 'note' }, `${plan.collapsed} repeated requests were folded into these steps.`));
  }
  if (plan.flows.length || plan.disabled.length) {
    parts.push(...section(
      'Values passed between steps',
      h('ul', {}, ...plan.flows.map(flowRow), ...plan.disabled.map(disabledRow)),
    ));
  }
  if (plan.config.length) {
    parts.push(...section(
      plan.embedSecrets ? 'Credentials in this script' : 'You need to supply',
      h('ul', {}, ...plan.config.map((item) => h(
        'li',
        {},
        h('code', {}, item.name),
        h('div', { class: 'note' }, item.reason),
      ))),
    ));
    if (plan.embedSecrets) {
      parts.push(h('div', { class: 'warning' }, 'This script now holds live credentials. Do not share it.'));
    } else {
      parts.push(h('p', { class: 'note' }, 'Keep the downloaded .env next to the script. It holds the values from this session.'));
    }
  }
  if (plan.warnings.length) {
    parts.push(...section('Check before running', ...plan.warnings.map((text) => h('div', { class: 'warning' }, text))));
  }
  $('plan').replaceChildren(...parts);
}

function showScripter(show) {
  $('recorder').hidden = show;
  $('scripter').hidden = !show;
}

// Wiring

function clearAll() {
  state.records = [];
  state.seen.clear();
  state.storedChars = 0;
  state.unticked.clear();
  state.disabledLinks.clear();
  state.selectedId = null;
  state.links = [];
  renderHosts();
  renderList();
  renderDetail();
}

async function importHar(file) {
  try {
    const records = fromHar(JSON.parse(await file.text()), state.nextId);
    state.nextId += records.length;
    for (const record of records) {
      trackBody(record);
      state.records.push(record);
    }
    scheduleRender();
    scheduleLinks();
    toast(`Imported ${records.length} requests`);
  } catch (error) {
    toast(`Could not import: ${error.message}`);
  }
}

function setScope(scope) {
  state.scope = scope;
  renderToolbar();
  renderHosts();
  renderList();
}

function moveSelection(delta) {
  const visible = visibleRecords();
  if (!visible.length) return;
  const index = visible.findIndex((record) => record.id === state.selectedId);
  const next = Math.min(visible.length - 1, Math.max(0, index + delta));
  selectRecord(visible[next].id);
  $('rows').children[next]?.scrollIntoView({ block: 'nearest' });
}

function wireEvents() {
  $('record').addEventListener('click', toggleRecording);
  $('clear').addEventListener('click', clearAll);
  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });
  $('scope-api').addEventListener('click', () => setScope('api'));
  $('scope-all').addEventListener('click', () => setScope('all'));
  $('host').addEventListener('change', (event) => {
    state.host = event.target.value;
    renderList();
  });
  $('tick-all').addEventListener('change', (event) => {
    for (const record of visibleRecords()) {
      if (event.target.checked) state.unticked.delete(record.id);
      else state.unticked.add(record.id);
    }
    renderList();
  });
  $('list').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
  });
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) importHar(file);
    event.target.value = '';
  });
  $('export').addEventListener('click', () => {
    const json = JSON.stringify(toHar(orderedRecords()), null, 2);
    saveFile('api_toolbar_session.har', json, 'application/json');
    toast('Saved. This file contains any credentials that were recorded.');
  });
  $('copy-all').addEventListener('click', () => {
    const records = tickedRecords();
    copyText(toCurlList(records, { clean: state.curlClean, redact: state.curlRedact }), `${records.length} curl commands copied`);
  });
  $('make-script').addEventListener('click', () => {
    buildOutput();
    showScripter(true);
  });
  $('back').addEventListener('click', () => showScripter(false));
  for (const id of ['keep-headers', 'embed-secrets']) $(id).addEventListener('change', buildOutput);
  $('script-name').addEventListener('input', buildOutput);
  $('copy-script').addEventListener('click', () => copyText(state.output.script, 'Script copied'));
  $('language').addEventListener('change', (event) => {
    setLanguage(event.target.value);
    buildOutput();
  });
  $('save-script').addEventListener('click', () => {
    const { script, extension, byteOrderMark } = state.output;
    saveFile(`${scriptName()}.${extension}`, `${byteOrderMark ? '\uFEFF' : ''}${script}`, 'text/plain');
  });
  $('save-env').addEventListener('click', () => {
    saveFile(`${scriptName()}.env`, state.output.env, 'text/plain');
  });
  $('close-detail').addEventListener('click', () => selectRecord(null));
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      renderDetail();
    });
  }
}

function applyTheme(name) {
  document.documentElement.dataset.theme = name === 'dark' ? 'dark' : 'light';
}

function initTheme() {
  const panels = devtools?.panels;
  if (panels) {
    applyTheme(panels.themeName);
    panels.setThemeChangeHandler?.(applyTheme);
  } else if (matchMedia('(prefers-color-scheme: dark)').matches) {
    applyTheme('dark');
  }
}

function renderLanguageOptions() {
  $('language').replaceChildren(...LANGUAGES.map(({ id, label }) => h('option', { value: id }, label)));
}

initTheme();
loadLanguage();
renderLanguageOptions();
renderLanguage();
wireEvents();
renderToolbar();
renderHosts();
renderList();
startCapture();
await loadTemplates();
