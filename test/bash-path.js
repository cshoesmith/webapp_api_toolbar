// On Windows a bare "bash" is the WSL launcher, which is slow and re-parses its
// arguments, so tests look for Git Bash first.
import { existsSync } from 'node:fs';

const GIT_BASH = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

export function bashPath() {
  if (process.env.TEST_BASH) return process.env.TEST_BASH;
  if (process.platform !== 'win32') return 'bash';
  const found = GIT_BASH.find((path) => existsSync(path));
  if (!found) throw new Error('Git Bash not found. Set TEST_BASH to a bash executable.');
  return found;
}
