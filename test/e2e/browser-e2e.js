// Loads the extension into a real browser, records real traffic from the
// recorder panel, makes a script through its UI, and runs that script. Headless
// browsers have no toolbar to click, so the panel opens as a tab here.
//
//   npm run test:e2e
//   E2E_BROWSER="C:\path\to\browser.exe" npm run test:e2e
//
// It uses an installed browser in headless mode with a throwaway profile. The
// browser must honour --load-extension: Edge, Chromium and Chrome for Testing
// do, but branded Chrome ignores it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, startServer } from '../fixtures/mock-server.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BROWSERS = [
  process.env.E2E_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.attached = [];
    socket.addEventListener('message', ({ data }) => this.receive(JSON.parse(data)));
  }

  static connect(url) {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => done(new Cdp(socket)));
      socket.addEventListener('error', () => fail(new Error('Could not connect to the browser.')));
    });
  }

  receive(message) {
    if (message.method === 'Target.attachedToTarget') this.attached.push(message.params);
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
    else waiter.done(message.result);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate(sessionId, expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, sessionId);
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }
}

function launch(browser, profile) {
  const child = spawn(browser, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1500,950',
    'about:blank',
  ]);
  return new Promise((done, fail) => {
    let log = '';
    child.stderr.on('data', (data) => {
      log += data;
      const match = /DevTools listening on (ws:\S+)/.exec(log);
      if (match) done({ child, url: match[1] });
    });
    child.on('exit', () => fail(new Error(`Browser exited early.\n${log}`)));
  });
}

const panelCall = (cdp, session) => ({
  text: (selector) => cdp.evaluate(session, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`),
  click: (selector) => cdp.evaluate(session, `document.querySelector(${JSON.stringify(selector)}).click()`),
  setValue: (selector, value) => cdp.evaluate(session, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('change', { bubbles: true }));
  })()`),
});

// Checks the panel's output, then runs its script with every token revoked.
async function checkScriptFlow({ cdp, ui, server, downloads, shoot }) {
  await waitFor(async () => parseInt(await ui.text('#count'), 10) >= 11, 'requests to be recorded');
  await sleep(800);
  console.log(`Recorded: ${await ui.text('#count')}`);
  assert.match(await ui.text('#count'), /^13 of 14/, 'the call to another site starts unticked');
  await ui.click('#tick-all');

  await ui.click('#rows tr:nth-child(2)');
  assert.match(await ui.text('#detail-body'), /curl '/);
  await ui.click('#detail-body button.primary');
  assert.match(await ui.text('#toast'), /copied/, 'copy works in this kind of page');
  console.log(`Clipboard: ${await ui.text('#toast')}`);

  await ui.click('[data-tab="response"]');
  assert.doesNotMatch(await ui.text('#detail-body'), /No body was captured/);

  await ui.click('#make-script');
  const results = {};
  for (const language of ['bash', 'python', 'powershell']) {
    await ui.setValue('#language', language);
    const script = await ui.text('#script');
    assert.doesNotMatch(script, new RegExp(PASSWORD), `${language} script hides the password`);
    results[language] = script;
  }
  const plan = await ui.text('#plan');
  console.log(`Plan: ${plan.slice(0, 300)}`);
  for (const expected of ['ACCESS_TOKEN', 'PASSWORD', 'for each', 'page loop']) {
    assert.ok(plan.includes(expected), `plan mentions ${expected}`);
  }
  assert.doesNotMatch(plan, /flow\.js/, 'script assets are not pulled in by chance');
  assert.match(plan, /COOKIES_/, 'cookies reached the extension');
  assert.doesNotMatch(plan, /browser cache/, 'recording bypasses the cache');
  assert.match(results.bash, /authorization: Bearer \$\{ACCESS_TOKEN\}/, 'Authorization reached the extension');

  await ui.click('#back');
  await shoot('recorder');
  await ui.click('#make-script');
  await shoot('script');

  await ui.click('#save-script');
  await ui.click('#save-env');
  await waitFor(() => existsSync(downloads) && readdirSync(downloads).filter((name) => !name.endsWith('.crdownload')).length >= 2, 'the downloads');
  const saved = readdirSync(downloads);
  console.log(`Downloaded: ${saved.join(', ')}`);

  server.rotate();
  delete server.state.embedOrigin;
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : 'powershell.exe';
  const script = saved.find((name) => name.endsWith('.ps1'));
  const running = spawn(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: downloads, env: { ...process.env, DELAY: '0' } });
  const log = [];
  running.stdout.on('data', (data) => log.push(String(data)));
  running.stderr.on('data', (data) => log.push(String(data)));
  const status = await new Promise((done) => { running.on('close', done); });
  assert.equal(status, 0, log.join(''));
  assert.equal(server.state.notes.length, 1, 'the script created a note with fresh tokens');
  assert.ok(server.state.hits.includes('GET /api/products/p_1005'), 'the loop reached the last product');
  assert.equal(server.state.embedOrigin, server.base, 'the cross-origin call replayed with the right Origin');
  const env = readFileSync(join(downloads, saved.find((name) => name.endsWith('.env'))), 'utf8');
  assert.match(env, /^PASSWORD=/m, 'the password comes from the user');
  assert.match(env, /^COOKIES_/m);
  console.log('Script ran against revoked tokens: OK');
}

async function withBrowser(scenario) {
  const browser = BROWSERS.find((path) => existsSync(path));
  assert.ok(browser, 'No browser found. Set E2E_BROWSER.');
  console.log(`Browser: ${browser}`);

  const scratch = mkdtempSync(join(tmpdir(), 'api-toolbar-e2e-'));
  const downloads = join(scratch, 'downloads');
  const server = await startServer();
  const { child, url } = await launch(browser, join(scratch, 'profile'));
  const cdp = await Cdp.connect(url);

  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const targets = async () => (await cdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
    const attach = async (target) => (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    const pageTarget = await waitFor(async () => (await targets()).find((item) => item.type === 'page'), 'the page');
    const page = await attach(pageTarget);
    await cdp.send('Page.enable', {}, page);
    await scenario({ cdp, server, downloads, targets, attach, page });
  } finally {
    const exited = new Promise((done) => { child.on('exit', done); });
    await cdp.send('Browser.close').catch(() => child.kill());
    await Promise.race([exited, sleep(5000)]);
    await server.close();
    // Cleanup must never hide the real result of the test.
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.warn(`Could not remove ${scratch}`);
    }
  }
}

const IGNORED_FLAG = 'If this is missing, the browser ignored --load-extension, as branded Chrome does. Use Edge or Chrome for Testing.';

function screenshots(cdp, session) {
  return async (name) => {
    if (!process.env.E2E_SHOTS) return;
    await sleep(150);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
    writeFileSync(join(process.env.E2E_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
}

async function runFlowInPage({ cdp, page, ui, server }) {
  await waitFor(() => cdp.evaluate(page, `typeof runFlow === 'function' && document.cookie.includes('device=')`), 'the page');
  // Fetched before recording too, so the recorded call would come from the
  // browser cache if recording left it on, and Chrome would then hide Origin.
  const embed = `fetch(${JSON.stringify(`${server.otherBase}/api/embed`)}).then((response) => response.status)`;
  assert.equal(await cdp.evaluate(page, embed), 200);
  await sleep(400);
  await ui.click('#clear');
  await cdp.evaluate(page, `runFlow((path, init) => fetch(path, init), ${JSON.stringify(PASSWORD)})`);
  assert.equal(await cdp.evaluate(page, embed), 200);
}

// Pages count as calls, because some sites send their data as HTML. The second
// address is another site, which moves the tab to a new browser process.
async function checkPageCapture({ cdp, ui, page, server }) {
  await ui.click('#clear');
  for (const base of [server.base, server.otherBase]) {
    await cdp.send('Page.navigate', { url: `${base}/page/sam` }, page);
    await waitFor(async () => (await ui.text('#rows')).includes(new URL(base).host), `${base} to be recorded`);
  }
  await ui.click('#rows tr:last-child');
  await ui.click('[data-tab="response"]');
  await waitFor(async () => (await ui.text('#detail-body')).includes('Profile of Sam'), 'the HTML to be captured');
  console.log('Pages are recorded with their HTML, across sites');
}

async function recordFromPanel({ cdp, server, downloads, targets, attach, page }) {
  const worker = await waitFor(async () => (await targets()).find((item) => item.url.endsWith('/src/background/service-worker.js')), `the service worker. ${IGNORED_FLAG}`);
  const background = await attach(worker);
  const extension = new URL(worker.url).host;
  await cdp.send('Runtime.enable', {}, background);
  await waitFor(() => cdp.evaluate(background, `typeof chrome === 'object' && Boolean(chrome.debugger)`), 'the extension APIs');

  const behavior = await cdp.evaluate(background, 'chrome.sidePanel.getPanelBehavior()');
  assert.equal(behavior.openPanelOnActionClick, true, 'the toolbar icon opens the side panel');
  console.log('Toolbar icon opens the side panel');

  await cdp.send('Page.navigate', { url: `${server.base}/` }, page);
  await waitFor(() => cdp.evaluate(page, `document.readyState === 'complete'`), 'the page to load');
  const [tabId] = await cdp.evaluate(background, 'chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.id))');
  // getTargets() also counts this test's own connection to the page, so ask
  // whether the extension itself can still talk to the tab.
  const isAttached = () => cdp.evaluate(background, `chrome.debugger.sendCommand({ tabId: ${tabId} }, 'Runtime.evaluate', { expression: '1' }).then(() => true, () => false)`);

  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extension}/src/panel/panel.html?tabId=${tabId}`,
    background: true,
  });
  const panel = await attach({ targetId });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
  const ui = panelCall(cdp, panel);
  await waitFor(async () => (await ui.text('#record-label')) === 'Stop', 'recording to start by itself');
  console.log(`Recording ${await ui.text('#target')}`);

  await runFlowInPage({ cdp, page, ui, server });
  await checkScriptFlow({ cdp, ui, server, downloads, shoot: screenshots(cdp, panel) });

  await ui.click('#back');
  await checkPageCapture({ cdp, ui, page, server });
  assert.equal(await isAttached(), true);
  await ui.click('#record');
  await waitFor(async () => !(await isAttached()), 'Stop to remove the debugger');
  assert.equal(await ui.text('#record-label'), 'Record');
  console.log('Stop detaches, which clears the banner');

  await ui.click('#record');
  await waitFor(isAttached, 'Record to attach again');
  await cdp.send('Target.closeTarget', { targetId });
  await waitFor(async () => !(await isAttached()), 'closing the panel to remove the debugger');
  console.log('Closing the panel detaches too');
}

await withBrowser(recordFromPanel);
