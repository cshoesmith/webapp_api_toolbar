// Generates a script in every language and runs it against a live mock server.
// Runtimes that are not installed are skipped, and the skip is reported.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate, loadTemplates } from '../src/lib/generate.js';
import { bashPath } from './bash-path.js';
import './fixtures/flow.js';
import { DEVICE_COOKIE, PASSWORD, startServer } from './fixtures/mock-server.js';
import { createRecorder } from './fixtures/recorder.js';

await loadTemplates();

const standIn = (path) => fileURLToPath(new URL(`./fixtures/stand-ins/${path}`, import.meta.url));
const pathWith = (dir) => (dir ? `${dir}${delimiter}${process.env.PATH}` : process.env.PATH);

function available(command, args, env = {}) {
  try {
    return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } }).status === 0;
  } catch {
    return false;
  }
}

// Real jq and requests are preferred. Without them the small stand-ins in
// test/fixtures/stand-ins keep the scripts running, and the test name says so.
const python = process.env.TEST_PYTHON ?? 'python';
const jqEnv = { PATH: pathWith(process.env.TEST_JQ_DIR) };
const realJq = available(bashPath(), ['-c', 'command -v jq'], jqEnv);
const realRequests = available(python, ['-c', 'import requests']);

const RUNTIMES = [
  {
    name: realJq ? 'bash' : 'bash (stand-in jq)',
    language: 'bash',
    command: bashPath(),
    env: realJq ? jqEnv : { PATH: pathWith(standIn('bin')) },
    args: (file) => [file],
    ready: () => available(bashPath(), ['-c', 'command -v curl']),
    missing: 'curl is not on PATH',
  },
  {
    name: realRequests ? 'Python' : 'Python (stand-in requests)',
    language: 'python',
    command: python,
    env: realRequests ? {} : { PYTHONPATH: standIn('python') },
    args: (file) => [file],
    ready: () => available(python, ['--version']),
    missing: 'Python is not installed',
  },
  {
    name: 'PowerShell 7',
    language: 'powershell',
    command: 'pwsh',
    args: (file) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    ready: () => available('pwsh', ['-NoProfile', '-Command', 'exit 0']),
    missing: 'pwsh is not installed',
  },
  {
    name: 'Windows PowerShell 5.1',
    language: 'powershell',
    command: 'powershell.exe',
    args: (file) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    ready: () => process.platform === 'win32' && available('powershell.exe', ['-NoProfile', '-Command', 'exit 0']),
    missing: 'Windows only',
  },
];

// Must stay async: the mock server lives in this process and spawnSync would
// stop it answering, leaving the script to time out.
function runScript(runtime, output) {
  const dir = mkdtempSync(join(tmpdir(), 'api-toolbar-'));
  const file = join(dir, `flow.${output.extension}`);
  writeFileSync(file, `${output.byteOrderMark ? '﻿' : ''}${output.script}`);
  if (output.env) writeFileSync(join(dir, 'flow.env'), output.env);
  return new Promise((resolve) => {
    const child = spawn(runtime.command, runtime.args(`flow.${output.extension}`), {
      cwd: dir,
      env: { ...process.env, DELAY: '0', ...runtime.env },
      timeout: 120000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (status) => resolve({ dir, status, stdout, stderr }));
  });
}

function outputDir(dir) {
  return join(dir, readdirSync(dir).find((name) => name.endsWith('_output')));
}

function lines(dir, ending) {
  const folder = outputDir(dir);
  const file = readdirSync(folder).find((name) => name.endsWith(ending));
  assert.ok(file, `no file ending ${ending} in ${readdirSync(folder).join(', ')}`);
  return readFileSync(join(folder, file), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('generated scripts against a live server', () => {
  let server;
  let recording;

  before(async () => {
    server = await startServer();
    const { api, records } = createRecorder(server.base, { cookies: [DEVICE_COOKIE] });
    // An earlier visit leaves a session cookie that the first request rotates,
    // and a script that keeps resending it would fail the CSRF check.
    await api('/');
    records.length = 0;
    await globalThis.runFlow(api, PASSWORD);
    recording = records;
  });

  after(() => server.close());

  for (const runtime of RUNTIMES) {
    const ready = runtime.ready();
    const skip = ready ? false : runtime.missing;

    test(`${runtime.name}: full flow with revoked tokens`, { skip }, async () => {
      server.rotate();
      const output = generate(recording, { language: runtime.language, scriptName: 'flow' });
      assert.doesNotMatch(output.script, new RegExp(PASSWORD));
      assert.deepEqual(output.plan.warnings.filter((text) => /still contains/.test(text)), []);

      const { dir, status, stdout, stderr } = await runScript(runtime, output);
      try {
        assert.equal(status, 0, `exit ${status}\n${stdout}\n${stderr}`);
        assert.doesNotMatch(`${stdout}${stderr}`, /<html/i, 'page bodies stay out of the log');
        // Recorded 2 pages and 2 details, so these prove the loops widened.
        assert.ok(server.state.hits.includes('GET /api/products?page=4&limit=2'), 'stopped at the empty page');
        for (let id = 1001; id <= 1005; id += 1) {
          assert.ok(server.state.hits.includes(`GET /api/products/p_${id}`), `fetched p_${id}`);
        }
        assert.deepEqual(server.state.notes, [{ owner: server.state.notes[0].owner, text: 'Hello from the flow', tags: ['a', 'b'] }]);
        assert.match(server.state.notes[0].owner, /^usr_/);

        assert.equal(lines(dir, '_products.ndjson').length, 5);
        assert.deepEqual(lines(dir, '_feed.ndjson').map((item) => item.position), [0, 1, 2]);
        assert.deepEqual(lines(dir, '_events.ndjson').map((item) => item.position), [0, 1, 2]);
        const details = readdirSync(outputDir(dir)).filter((name) => name.endsWith('.ndjson')).map((name) => {
          return readFileSync(join(outputDir(dir), name), 'utf8').trim().split('\n').length;
        });
        assert.ok(details.filter((count) => count === 5).length >= 2, 'list and details each hold 5 records');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${runtime.name}: reports every missing setting`, { skip }, async () => {
      const output = generate(recording, { language: runtime.language, scriptName: 'flow' });
      const { dir, status, stdout, stderr } = await runScript(runtime, { ...output, env: '' });
      try {
        assert.notEqual(status, 0);
        assert.match(`${stdout}${stderr}`, /PASSWORD/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${runtime.name}: credentials embedded in the script work`, { skip }, async () => {
      server.rotate();
      const output = generate(recording, { language: runtime.language, scriptName: 'flow', embedSecrets: true });
      assert.equal(output.env, '');
      assert.match(output.script, new RegExp(PASSWORD));
      const { dir, status, stdout, stderr } = await runScript(runtime, output);
      rmSync(dir, { recursive: true, force: true });
      assert.equal(status, 0, `${stdout}\n${stderr}`);
    });

    test(`${runtime.name}: an HTML error page is saved, not printed`, { skip }, async () => {
      server.state.gateClosed = false;
      const { api, records } = createRecorder(server.base);
      await api('/api/gate');
      server.state.gateClosed = true;
      const output = generate(records, { language: runtime.language, scriptName: 'flow' });
      const { dir, status, stdout, stderr } = await runScript(runtime, output);
      try {
        const log = `${stdout}${stderr}`;
        assert.notEqual(status, 0);
        assert.doesNotMatch(log, /Blocked page body/, 'the page is not in the log');
        assert.match(log, /403/);
        const name = readdirSync(outputDir(dir)).find((item) => item.includes('get_api_gate'));
        assert.match(readFileSync(join(outputDir(dir), name), 'utf8'), /Blocked page body/);
        assert.match(log, new RegExp(name.replace('.', '\\.')), 'the log says where it was saved');
        assert.match(log, /flow_output/, 'the log says where responses go');
      } finally {
        server.state.gateClosed = false;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${runtime.name}: braces and brackets in a URL are sent once, as recorded`, { skip }, async () => {
      const { api, records } = createRecorder(server.base);
      await api('/api/echo?filter[status]=open&page[size]=2&vars={a,b}');
      const [sent] = server.state.echoes.splice(0);
      const output = generate(records, { language: runtime.language, scriptName: 'flow' });
      const { dir, status, stdout, stderr } = await runScript(runtime, output);
      try {
        assert.equal(status, 0, `${stdout}\n${stderr}`);
        const replayed = server.state.echoes.splice(0);
        assert.equal(replayed.length, 1, 'one request, not one per pattern match');
        assert.equal(decodeURIComponent(replayed[0].url), decodeURIComponent(sent.url));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${runtime.name}: a hostile recording replays exactly and runs nothing`, { skip }, async () => {
      const hostile = [
        `it's`,
        '$(touch PWNED)',
        '`touch PWNED`',
        '${IFS}{{steps}}',
        `{__import__('os').system('touch PWNED')}`,
        `$(New-Item PWNED)`,
        `’; New-Item PWNED; ’`,
        `“$(New-Item PWNED)”`,
        'back\\slash\\n',
        'percent %41 %s',
        'new\nline\ttab',
        'ünï çødé 日本語 🦊',
      ];
      const value = hostile.join(' | ');
      const { api, records } = createRecorder(server.base);
      await api('/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': value.replace(/[\n\t]/g, ' ').replace(/[^\x20-\x7e]/g, '?') },
        body: JSON.stringify({ note: value, password: 'not-a-real-password', nested: { [`k'"$(x)`]: [value] } }),
      });
      await api(`/api/echo?q=${encodeURIComponent(value)}&plain=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ field: value, token: 'not-a-real-token' }).toString(),
      });
      await api('/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: value,
      });
      const sent = server.state.echoes.splice(0);
      const output = generate(records, { language: runtime.language, scriptName: 'flow', selectedIds: records.map((item) => item.id) });
      const { dir, status, stdout, stderr } = await runScript(runtime, output);
      try {
        assert.equal(status, 0, `${stdout}\n${stderr}`);
        const replayed = server.state.echoes.splice(0);
        assert.equal(replayed.length, sent.length);
        assert.ok(!existsSync(join(dir, 'PWNED')), 'a captured value ran as code');
        replayed.forEach((echo, index) => {
          const original = sent[index];
          assert.equal(echo.url, original.url);
          assert.equal(echo.headers['x-custom'], original.headers['x-custom']);
          const type = echo.headers['content-type'] ?? '';
          if (/json/.test(type)) assert.deepEqual(JSON.parse(echo.body), JSON.parse(original.body));
          else if (/form/.test(type)) assert.deepEqual(new URLSearchParams(echo.body).get('field'), value);
          else assert.equal(echo.body, original.body);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
