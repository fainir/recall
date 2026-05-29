import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Recall } from '../src/index.js';

let dir;
let r;

before(async () => {
  dir = path.join(os.tmpdir(), `recall-test-${process.pid}-${Date.now()}`);
  r = new Recall({ dir });
});

after(async () => {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
});

test('write + get roundtrip preserves frontmatter and body', async () => {
  await r.write({
    name: 'voice',
    type: 'user',
    description: 'the founder voice',
    decay_class: 'permanent',
    body: 'Terse. Signs -N.',
  });
  const got = await r.get('voice');
  assert.equal(got.frontmatter.name, 'voice');
  assert.equal(got.frontmatter.type, 'user');
  assert.equal(got.frontmatter.decay_class, 'permanent');
  assert.match(got.body, /Terse/);
});

test('invalid slug rejected', async () => {
  await assert.rejects(r.write({ name: 'Bad Name', type: 'user' }));
  await assert.rejects(r.write({ name: 'has space', type: 'user' }));
});

test('invalid type rejected', async () => {
  await assert.rejects(r.write({ name: 'x', type: 'bogus' }));
});

test('get returns null for unknown name', async () => {
  const got = await r.get('does-not-exist');
  assert.equal(got, null);
});

test('list filters by type', async () => {
  await r.write({ name: 'investors', type: 'project', body: 'Sequoia, Accel' });
  await r.write({ name: 'pr', type: 'feedback', body: 'no auto-send' });
  const projects = await r.list({ type: 'project' });
  assert.ok(projects.some(m => m.name === 'investors'));
  assert.ok(!projects.some(m => m.name === 'pr'));
});

test('recall walks wiki-links to depth 1', async () => {
  await r.write({ name: 'top-customers', type: 'project',
    body: 'Northwind ($48K), see [[northwind-account]]' });
  await r.write({ name: 'northwind-account', type: 'project',
    body: 'CSM: Maya. Renewal Q3.' });
  const out = await r.recall({ requires: ['top-customers'], link_depth: 1 });
  const names = out.memories.map(m => m.name);
  assert.ok(names.includes('top-customers'));
  assert.ok(names.includes('northwind-account'), `links should resolve, got ${names}`);
});

test('recall enforces token budget by dropping ephemeral first', async () => {
  await r.write({ name: 'big-permanent', type: 'user', decay_class: 'permanent',
    body: 'x'.repeat(1200) });
  await r.write({ name: 'big-ephemeral', type: 'project', decay_class: 'ephemeral',
    body: 'y'.repeat(1200) });
  const out = await r.recall({
    requires: ['big-permanent', 'big-ephemeral'],
    budget_tokens: 400,
  });
  const names = out.memories.map(m => m.name);
  // We can't fit both - the ephemeral one must be the first to go
  assert.ok(!names.includes('big-ephemeral'),
    `ephemeral should be dropped first, got ${names}`);
});

test('dueForReview surfaces aged memories', async () => {
  // Write with a forced old date
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const file = `---\nname: ancient\ntype: project\ndecay_class: slow\nupdated_at: ${old}\n---\nold content`;
  await fs.writeFile(path.join(dir, 'ancient.md'), file, 'utf8');
  const due = await r.dueForReview();
  assert.ok(due.some(m => m.name === 'ancient'),
    `ancient memory aged ${100} days with slow decay (90d) should be due`);
});

test('delete removes the memory file', async () => {
  await r.write({ name: 'temp', type: 'project', body: 'gone soon' });
  assert.ok(await r.get('temp'));
  assert.equal(await r.delete('temp'), true);
  assert.equal(await r.get('temp'), null);
});
