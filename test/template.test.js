import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  neededHelpers,
  parseTemplate,
  renderSnippet,
  renderTemplate,
} from '../src/lib/template-engine.js';

const render = (text, values, code = '') => {
  const template = parseTemplate(text);
  return renderTemplate(template, values, neededHelpers(template, code));
};

test('placeholders are filled in', () => {
  assert.equal(render('a {{x}} b\n', { x: 1 }), 'a 1 b\n');
});

test('an unknown placeholder is an error, so template typos surface', () => {
  assert.throws(() => render('{{missing}}\n', {}), /missing/);
});

test('an empty value on its own line removes the line', () => {
  assert.equal(render('a\n{{x}}\nb\n', { x: '' }), 'a\nb\n');
});

test('multi-line values take the indent of their line', () => {
  assert.equal(render('  {{x}}\n', { x: 'one\ntwo' }), '  one\n  two\n');
});

test('if and else pick a branch', () => {
  const text = '# @if on\nyes\n# @else\nno\n# @end\n';
  assert.equal(render(text, { on: true }), 'yes\n');
  assert.equal(render(text, { on: false }), 'no\n');
});

test('nested blocks close in the right order', () => {
  const text = '# @if a\n# @if b\nboth\n# @end\nouter\n# @end\n';
  assert.equal(render(text, { a: true, b: false }), 'outer\n');
});

test('helpers appear only when called, including helpers of helpers', () => {
  const text = '# @helper inner\ninner()\n# @end\n# @helper outer\nouter() { inner; }\n# @end\n# @helper unused\nunused()\n# @end\n';
  const output = render(text, {}, 'outer');
  assert.match(output, /inner\(\)/);
  assert.match(output, /outer\(\)/);
  assert.doesNotMatch(output, /unused/);
});

test('snippets stay out of the script until they are rendered', () => {
  const template = parseTemplate('main\n# @snippet step\nrun {{what}}\n# @end\n');
  assert.equal(renderTemplate(template, {}, new Set()), 'main\n');
  assert.equal(renderSnippet(template, 'step', { what: 'it' }), 'run it');
});

test('inserted values are never read as template syntax', () => {
  const hostile = '{{secret}}\n# @if secret\n# @helper x\n# @end';
  assert.equal(render('{{x}}\n', { x: hostile, secret: 'leak' }), `${hostile}\n`);
});

test('broken templates fail with a clear message', () => {
  assert.throws(() => parseTemplate('# @end\n'), /nothing to close/);
  assert.throws(() => parseTemplate('# @if x\n'), /not closed/);
  assert.throws(() => parseTemplate('# @else\n'), /outside @if/);
});
