import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Recall } from '../src/index.js';
import { handle, parseArgs, openStore } from '../bin/recall-mcp.js';
import { fresh } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/recall-mcp.js', import.meta.url));

let nextId = 1;
const req = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, params });
const call = (name, args) => req('tools/call', { name, arguments: args });
const text = res => res.result.content.map(c => c.text).join('');

async function server({ readOnly = false } = {}) {
  const { dir } = await fresh();
  const store = new Recall({ dir, format: 'claude-code' });
  return { dir, store, send: msg => handle(msg, { store, readOnly }) };
}

test('initialize: echoes a supported protocol version, falls back to the newest otherwise', async () => {
  const { send } = await server();
  const ok = await send(req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(ok.result.protocolVersion, '2025-06-18');
  assert.deepEqual(ok.result.capabilities, { tools: {} });
  assert.equal(ok.result.serverInfo.name, 'recall');
  assert.match(ok.result.instructions, /shared with Claude Code/);

  const future = await send(req('initialize', { protocolVersion: '2099-01-01' }));
  assert.equal(future.result.protocolVersion, '2025-11-25');
});

test('notifications get no response; ping does; unknown methods are -32601', async () => {
  const { send } = await server();
  assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await send(req('ping'))).result, {});
  assert.equal((await send(req('resources/list'))).error.code, -32601);
  assert.equal((await send({ id: 9, method: 'ping' })).error.code, -32600);
});

test('tools: write, list, get (either spelling), recall, due, delete', async () => {
  const { dir, send } = await server();
  const names = (await send(req('tools/list'))).result.tools.map(t => t.name);
  assert.deepEqual(names, ['memory_list', 'memory_get', 'memory_recall', 'memory_due', 'memory_write', 'memory_delete']);

  const w = await send(call('memory_write', { name: 'feedback_testing', type: 'feedback', description: 'run integration tests', body: 'Use npm run test:int. See [[reference_ci]].' }));
  assert.equal(w.result.isError, false);
  assert.match(await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8'), /feedback_testing\.md\) - run integration tests/);

  assert.match(text(await send(call('memory_list', {}))), /1 memories in .*\n- feedback_testing \(feedback\) - run integration tests/);
  assert.match(text(await send(call('memory_get', { name: 'feedback-testing' }))), /^# feedback_testing \(feedback\)/);

  const recalled = text(await send(call('memory_recall', { requires: ['feedback_testing', 'nope'] })));
  assert.match(recalled, /## feedback_testing/);
  assert.match(recalled, /missing: nope, reference_ci/); // required names first, then links

  assert.equal(text(await send(call('memory_due', { as_of: '2020-01-01' }))), 'Nothing is due for review.');
  assert.equal(text(await send(call('memory_delete', { name: 'feedback_testing' }))), 'Deleted feedback_testing');
});

test('tool errors come back as isError results, not protocol errors', async () => {
  const { send } = await server();
  const missing = await send(call('memory_get', { name: 'ghost' }));
  assert.equal(missing.result.isError, true);
  assert.match(text(missing), /No memory named "ghost"/);

  const bad = await send(call('memory_write', { name: '../escape', type: 'user', description: '', body: 'x' }));
  assert.equal(bad.result.isError, true);
  assert.match(text(bad), /Invalid name/);

  assert.equal((await send(call('memory_teleport', {}))).error.code, -32602);
});

test('read-only mode hides and refuses the write tools', async () => {
  const { send } = await server({ readOnly: true });
  const names = (await send(req('tools/list'))).result.tools.map(t => t.name);
  assert.deepEqual(names, ['memory_list', 'memory_get', 'memory_recall', 'memory_due']);
  const refused = await send(call('memory_write', { name: 'x', type: 'user', description: '', body: 'x' }));
  assert.equal(refused.error.code, -32602);
  assert.match(refused.error.message, /read-only/);
});

test('parseArgs and openStore', async () => {
  assert.deepEqual(parseArgs([], {}), { mode: null, project: null, dir: null, format: null, readOnly: false });
  assert.equal(parseArgs(['--claude-code', '/repo', '--read-only'], {}).project, '/repo');
  assert.equal(parseArgs(['--claude-code', '--read-only'], {}).project, null);
  assert.deepEqual(parseArgs([], { RECALL_DIR: '/m', RECALL_READ_ONLY: '1' }), { mode: 'dir', project: null, dir: '/m', format: null, readOnly: true });
  assert.throws(() => parseArgs(['--dir'], {}), /--dir needs a value/);
  assert.throws(() => parseArgs(['--format', 'claude-code'], {}), /only applies with --dir/);
  assert.throws(() => parseArgs(['--bogus'], {}), /unknown option/);

  const { dir } = await fresh();
  assert.equal(openStore({ mode: 'dir', dir }).format, 'recall');
  assert.equal(openStore({ mode: 'dir', dir, format: 'claude-code' }).format, 'claude-code');
  const cc = openStore({ mode: null }, dir);
  assert.equal(cc.format, 'claude-code');
  assert.match(cc.dir, /[/\\]projects[/\\].+[/\\]memory$/);
});

test('end to end over stdio: the real binary answers in order and exits when stdin closes', async () => {
  const { dir } = await fresh();
  const child = spawn(process.execPath, [BIN, '--dir', dir, '--format', 'claude-code'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const lines = [
    req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    call('memory_write', { name: 'a', type: 'project', description: 'first', body: 'links to [[b]]' }),
    call('memory_write', { name: 'b', type: 'project', description: 'second', body: 'leaf' }),
    call('memory_recall', { requires: ['a'] }),
  ].map(m => JSON.stringify(m));
  child.stdin.end(`${lines.join('\n')}\nnot json\n`);
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);

  const replies = out.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(replies.length, 5); // no reply to the notification
  assert.equal(replies[0].result.serverInfo.name, 'recall');
  assert.match(replies[3].result.content[0].text, /## a \(project\)[\s\S]*## b \(project\)/);
  assert.equal(replies[4].error.code, -32700);
});
