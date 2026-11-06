// Offline checks for the workflow exports. No dependencies, no n8n instance needed.
//
//   node scripts/validate.mjs
//
// What it checks:
//   - every workflow.json parses and has the shape n8n expects (nodes, connections, positions, versions)
//   - node names and ids are unique, every connection points at an existing node
//   - every node is reachable from a trigger
//   - no credentials block and nothing that looks like a secret (API keys, bot tokens, private keys)
//   - every {{ expression }} is balanced and compiles as JavaScript
//   - every Code node compiles as JavaScript
//
// It does not run the workflows. Import them into n8n to test them end to end.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = readdirSync(root).filter((d) => /^\d\d-/.test(d) && statSync(join(root, d)).isDirectory());

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style key'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'Telegram bot token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
];

let failures = 0;
const fail = (dir, message) => {
  failures += 1;
  console.error(`  FAIL ${dir}: ${message}`);
};

function* strings(value, path = '') {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
}

function checkExpression(dir, where, text) {
  if (!text.startsWith('=') || !text.includes('{{')) return;
  const opens = (text.match(/\{\{/g) || []).length;
  const closes = (text.match(/\}\}/g) || []).length;
  if (opens !== closes) return fail(dir, `${where}: unbalanced {{ }} in expression`);
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1];
    if (inner.includes('{{') || inner.includes('}}')) fail(dir, `${where}: nested braces inside an expression`);
    try {
      new Function(`return (${inner});`);
    } catch (error) {
      fail(dir, `${where}: expression does not compile (${error.message}): ${inner.trim().slice(0, 80)}`);
    }
  }
}

for (const dir of dirs) {
  const file = join(root, dir, 'workflow.json');
  let wf;
  try {
    wf = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(dir, `workflow.json is not valid JSON: ${error.message}`);
    continue;
  }

  if (typeof wf.name !== 'string' || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object') {
    fail(dir, 'missing name, nodes or connections');
    continue;
  }

  const names = new Set();
  const ids = new Set();
  for (const n of wf.nodes) {
    for (const key of ['id', 'name', 'type']) if (typeof n[key] !== 'string') fail(dir, `node without ${key}`);
    if (typeof n.typeVersion !== 'number') fail(dir, `${n.name}: typeVersion must be a number`);
    if (!Array.isArray(n.position) || n.position.length !== 2 || n.position.some((p) => typeof p !== 'number')) {
      fail(dir, `${n.name}: bad position`);
    }
    if (typeof n.parameters !== 'object' || n.parameters === null) fail(dir, `${n.name}: parameters missing`);
    if (names.has(n.name)) fail(dir, `duplicate node name: ${n.name}`);
    if (ids.has(n.id)) fail(dir, `duplicate node id: ${n.id}`);
    names.add(n.name);
    ids.add(n.id);
    if ('credentials' in n) fail(dir, `${n.name}: contains a credentials block`);
  }

  // connections
  const edges = new Map();
  for (const [from, outputs] of Object.entries(wf.connections)) {
    if (!names.has(from)) fail(dir, `connection from unknown node: ${from}`);
    for (const group of outputs.main || []) {
      for (const link of group) {
        if (!names.has(link.node)) fail(dir, `${from} connects to unknown node: ${link.node}`);
        if (!edges.has(from)) edges.set(from, []);
        edges.get(from).push(link.node);
      }
    }
  }

  // reachability from triggers
  const isTrigger = (n) => /webhook$|trigger$/i.test(n.type) && !/respondToWebhook/i.test(n.type);
  const triggers = wf.nodes.filter(isTrigger);
  if (triggers.length === 0) fail(dir, 'no trigger node');
  const seen = new Set();
  const stack = triggers.map((t) => t.name);
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) || []) stack.push(next);
  }
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.stickyNote') continue;
    if (!seen.has(n.name)) fail(dir, `${n.name} is not reachable from a trigger`);
  }

  // secrets, expressions, code
  const text = JSON.stringify(wf);
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) fail(dir, `looks like a secret (${label})`);

  for (const n of wf.nodes) {
    for (const [path, s] of strings(n.parameters)) {
      if (path === '.jsCode') {
        try {
          new Function(s);
        } catch (error) {
          fail(dir, `${n.name}: code does not compile (${error.message})`);
        }
      } else {
        checkExpression(dir, `${n.name}${path}`, s);
      }
    }
  }

  const real = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
  console.log(`${failures ? '..' : 'ok'}  ${dir}: ${real} nodes, ${[...edges.values()].flat().length} connections`);
}

if (dirs.length === 0) {
  console.error('No workflow folders found.');
  process.exit(1);
}
if (failures) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`\nAll ${dirs.length} workflows passed.`);
