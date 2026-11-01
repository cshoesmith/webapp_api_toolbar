// Makes real commits in a throwaway repository with the real hook turned on.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

function repository(context) {
  const dir = mkdtempSync(join(tmpdir(), 'api-toolbar-version-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const read = (file) => readFileSync(join(dir, file), 'utf8');
  const write = (file, text) => writeFileSync(join(dir, file), text);
  const manifest = (version, description = 'first') => JSON.stringify({ manifest_version: 3, version, description }, null, 2);
  const committed = (file) => JSON.parse(git('show', `HEAD:${file}`));

  cpSync(join(ROOT, '.githooks'), join(dir, '.githooks'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'bump-version.js'), join(dir, 'scripts', 'bump-version.js'));
  write('manifest.json', manifest('0.1.0'));
  write('package.json', JSON.stringify({ name: 'x', version: '0.1.0', type: 'module' }, null, 2));
  write('note.txt', 'one');
  write('other.txt', 'one');
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-qm', 'Before the hook is on');
  git('config', 'core.hooksPath', '.githooks');
  return { git, read, write, manifest, committed };
}

const versions = (repo) => [repo.committed('manifest.json').version, repo.committed('package.json').version];

test('every commit adds one to the patch version in both files', (context) => {
  const repo = repository(context);
  repo.write('note.txt', 'two');
  repo.git('add', 'note.txt');
  repo.git('commit', '-qm', 'Change');
  assert.deepEqual(versions(repo), ['0.1.1', '0.1.1']);
  repo.write('note.txt', 'three');
  repo.git('commit', '-qam', 'Change again');
  assert.deepEqual(versions(repo), ['0.1.2', '0.1.2']);
  assert.equal(JSON.parse(repo.read('manifest.json')).version, '0.1.2', 'the working copy matches');
  assert.equal(repo.git('status', '--porcelain'), '', 'nothing is left over');
});

test('unstaged changes to a version file stay out of the commit', (context) => {
  const repo = repository(context);
  repo.write('manifest.json', repo.manifest('0.1.0', 'half finished'));
  repo.write('note.txt', 'two');
  repo.git('add', 'note.txt');
  repo.git('commit', '-qm', 'Change');
  assert.equal(repo.committed('manifest.json').version, '0.1.1');
  assert.equal(repo.committed('manifest.json').description, 'first');
  const working = JSON.parse(repo.read('manifest.json'));
  assert.equal(working.description, 'half finished', 'the edit is still there');
  assert.equal(working.version, '0.1.1');
});

test('a version raised by hand is kept', (context) => {
  const repo = repository(context);
  repo.write('manifest.json', repo.manifest('0.2.0'));
  repo.git('add', 'manifest.json');
  repo.git('commit', '-qm', 'Start 0.2');
  assert.deepEqual(versions(repo), ['0.2.0', '0.2.0']);
  repo.write('note.txt', 'two');
  repo.git('commit', '-qam', 'Change');
  assert.deepEqual(versions(repo), ['0.2.1', '0.2.1']);
});

test('the patch number carries past nine', (context) => {
  const repo = repository(context);
  repo.write('manifest.json', repo.manifest('0.1.9'));
  repo.git('commit', '-qam', 'Raise');
  repo.write('note.txt', 'two');
  repo.git('commit', '-qam', 'Change');
  assert.deepEqual(versions(repo), ['0.1.10', '0.1.10']);
});

test('a commit with nothing staged is still refused', (context) => {
  const repo = repository(context);
  assert.throws(() => repo.git('commit', '-qm', 'Nothing'));
  assert.deepEqual(versions(repo), ['0.1.0', '0.1.0']);
  assert.equal(repo.git('status', '--porcelain'), '');
});

test('committing named files never moves the version backwards', (context) => {
  const repo = repository(context);
  repo.write('note.txt', 'two');
  repo.git('commit', '-qm', 'Named file', 'note.txt');
  assert.deepEqual(versions(repo), ['0.1.1', '0.1.1']);
  repo.write('other.txt', 'two');
  repo.git('add', 'other.txt');
  repo.git('commit', '-qm', 'Next');
  assert.deepEqual(versions(repo), ['0.1.2', '0.1.2']);
});
