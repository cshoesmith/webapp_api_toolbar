// Run by .githooks/pre-commit. Adds one to the patch version on every commit, or
// keeps a version raised by hand. It edits the staged copies directly, so other
// unstaged changes to these files stay out of the commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['manifest.json', 'package.json'];
const VERSION = /"version": "(\d+\.\d+\.\d+)"/;

const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input, stdio: 'pipe' });
const versionIn = (text) => VERSION.exec(text)[1];
const parts = (version) => version.split('.').map(Number);

function isAhead(version, other) {
  const [difference = 0] = parts(version)
    .map((part, index) => part - parts(other)[index])
    .filter(Boolean);
  return difference > 0;
}

function nextVersion() {
  const staged = versionIn(git(['show', ':manifest.json']));
  const committed = versionIn(git(['show', 'HEAD:manifest.json']));
  if (isAhead(staged, committed)) return staged;
  const [major, minor, patch] = parts(committed);
  return `${major}.${minor}.${patch + 1}`;
}

function setVersion(file, version) {
  const stamped = (text) => text.replace(VERSION, `"version": "${version}"`);
  const blob = git(['hash-object', '-w', '--stdin'], stamped(git(['show', `:${file}`]))).trim();
  git(['update-index', '--cacheinfo', `100644,${blob},${file}`]);
  writeFileSync(file, stamped(readFileSync(file, 'utf8')));
}

// Git checks for an empty commit after this runs, so bumping here would turn a
// refused commit into one that only changes the version.
if (git(['diff', '--cached', '--name-only']).trim()) {
  const version = nextVersion();
  for (const file of FILES) setVersion(file, version);
  console.error(`Version ${version}`);
}
