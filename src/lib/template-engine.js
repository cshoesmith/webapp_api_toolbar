// A small template language for the files in src/templates.
//
//   {{name}}              Replaced with a value. On a line of its own, an empty
//                         value removes the line. Later lines of a multi-line
//                         value take on the indent of the line it sits on.
//   # @if name            Keeps the block when the value is truthy. @else works.
//   # @helper name        Keeps the block only when the script calls `name`.
//   # @snippet name       A named block, rendered for each step that needs it.
//   # @end                Closes any of the blocks above.
//
// Values are inserted in a single pass and never rescanned. They hold captured
// text, so a response containing {{steps}} or "# @if" must stay plain text.

const DIRECTIVE = /^\s*#\s*@(if|else|helper|snippet|end)(?:\s+(\S+))?\s*$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const ONLY_PLACEHOLDER = /^\s*\{\{\w+\}\}\s*$/;

export function parseTemplate(text) {
  const root = { nodes: [] };
  const snippets = new Map();
  const helpers = [];
  const stack = [root];

  text.split(/\r?\n/).forEach((line, index) => {
    const match = DIRECTIVE.exec(line);
    const current = stack.at(-1);
    if (!match) {
      current.nodes.push({ type: 'line', text: line });
      return;
    }
    const [, directive, name] = match;
    if (directive === 'end') {
      if (stack.length === 1) throw new Error(`Template line ${index + 1}: @end with nothing to close.`);
      stack.pop();
    } else if (directive === 'else') {
      if (current.type !== 'if') throw new Error(`Template line ${index + 1}: @else outside @if.`);
      current.nodes = current.otherwise;
    } else {
      const block = { type: directive, name, nodes: [], otherwise: [] };
      block.then = block.nodes;
      if (directive === 'snippet') snippets.set(name, block);
      else current.nodes.push(block);
      if (directive === 'helper') helpers.push(block);
      stack.push(block);
    }
  });
  if (stack.length > 1) throw new Error(`Template block @${stack.at(-1).type} ${stack.at(-1).name} is not closed.`);
  return { nodes: root.nodes, snippets, helpers };
}

function fillLine(line, values) {
  const indent = /^\s*/.exec(line)[0];
  const lookup = (key) => {
    if (!(key in values)) throw new Error(`Template uses {{${key}}}, which has no value.`);
    return String(values[key]);
  };
  if (ONLY_PLACEHOLDER.test(line) && !lookup(line.trim().slice(2, -2))) return [];
  const filled = line.replace(PLACEHOLDER, (_, key) => lookup(key));
  return filled.split('\n').map((text, index) => (index > 0 && text ? `${indent}${text}` : text));
}

function renderNodes(nodes, values, keep) {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'line': return fillLine(node.text, values);
      case 'if': return renderNodes(values[node.name] ? node.then : node.otherwise, values, keep);
      case 'helper': return keep.has(node) ? renderNodes(node.then, values, keep) : [];
      default: return [];
    }
  });
}

export function renderSnippet(template, name, values) {
  const snippet = template.snippets.get(name);
  if (!snippet) throw new Error(`Template has no snippet named ${name}.`);
  return renderNodes(snippet.then, values, new Set()).join('\n');
}

// Finds the helpers `code` calls, plus any helpers those helpers call.
export function neededHelpers(template, code) {
  const keep = new Set();
  let search = code;
  for (let added = true; added;) {
    added = false;
    for (const helper of template.helpers) {
      if (keep.has(helper) || !search.includes(helper.name)) continue;
      keep.add(helper);
      search += `\n${helper.then.map((node) => node.text).join('\n')}`;
      added = true;
    }
  }
  return keep;
}

export function renderTemplate(template, values, keep) {
  const lines = renderNodes(template.nodes, values, keep);
  // Dropped blocks leave gaps behind, so tidy them up. No string literal in a
  // script spans lines, which makes this safe.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
