import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.js';

const names = out => out.memories.map(m => m.name);

test('budget drops keep the remaining memories in walk order', async () => {
  const { r } = await fresh();
  await r.write({ name: 'first', type: 'user', decay_class: 'slow', body: 'a'.repeat(40) });
  await r.write({ name: 'second', type: 'user', decay_class: 'permanent', body: 'b'.repeat(40) });
  await r.write({ name: 'third', type: 'user', decay_class: 'ephemeral', body: 'c'.repeat(2000) });
  const out = await r.recall({ requires: ['first', 'second', 'third'], budget_tokens: 200 });
  assert.deepEqual(names(out), ['first', 'second']);
  assert.deepEqual(out.dropped, ['third']);
});

test('linked memories are dropped before required ones', async () => {
  const { r } = await fresh();
  await r.write({ name: 'job-notes', type: 'project', decay_class: 'ephemeral',
    body: 'today: call [[northwind]] ' + 'n'.repeat(400) });
  await r.write({ name: 'northwind', type: 'project', decay_class: 'permanent', body: 'w'.repeat(400) });
  const out = await r.recall({ requires: ['job-notes'], budget_tokens: 150 });
  assert.deepEqual(names(out), ['job-notes']);
  assert.deepEqual(out.dropped, ['northwind']);
});

test('deeper links are dropped before shallower ones', async () => {
  const { r } = await fresh();
  await r.write({ name: 'root', type: 'project', body: '[[mid]]' });
  await r.write({ name: 'mid', type: 'project', decay_class: 'permanent', body: '[[deep]] ' + 'm'.repeat(200) });
  await r.write({ name: 'deep', type: 'project', decay_class: 'permanent', body: 'd'.repeat(200) });
  const out = await r.recall({ requires: ['root'], link_depth: 2, budget_tokens: 120 });
  assert.deepEqual(names(out), ['root', 'mid']);
  assert.deepEqual(out.dropped, ['deep']);
});

test('tokens_used matches the memories actually returned', async () => {
  const { r } = await fresh();
  await r.write({ name: 'a', type: 'user', body: 'x'.repeat(500) });
  await r.write({ name: 'b', type: 'user', decay_class: 'ephemeral', body: 'y'.repeat(500) });
  const all = await r.recall({ requires: ['a', 'b'], budget_tokens: Infinity });
  const one = await r.recall({ requires: ['a'], budget_tokens: Infinity });
  const cut = await r.recall({ requires: ['a', 'b'], budget_tokens: one.tokens_used });
  assert.ok(all.tokens_used > one.tokens_used);
  assert.deepEqual(names(cut), ['a']);
  assert.equal(cut.tokens_used, one.tokens_used);
});

test('missing and invalid names are skipped and reported, not thrown', async () => {
  const { r } = await fresh();
  await r.write({ name: 'voice', type: 'user', body: 'see [[ghost]]' });
  const out = await r.recall({ requires: ['voice', 'nope', 'Not A Slug', '../etc/passwd'] });
  assert.deepEqual(names(out), ['voice']);
  assert.deepEqual(out.missing, ['nope', 'Not A Slug', '../etc/passwd', 'ghost']);
  assert.deepEqual(out.dropped, []);
});

test('link_depth 0 returns only the required memories; cycles terminate', async () => {
  const { r } = await fresh();
  await r.write({ name: 'a', type: 'user', body: '[[b]]' });
  await r.write({ name: 'b', type: 'user', body: '[[a]] [[c]]' });
  await r.write({ name: 'c', type: 'user', body: '[[a]]' });
  assert.deepEqual(names(await r.recall({ requires: ['a'], link_depth: 0 })), ['a']);
  assert.deepEqual(names(await r.recall({ requires: ['a'], link_depth: 10 })), ['a', 'b', 'c']);
  assert.deepEqual(names(await r.recall({ requires: ['a', 'a', 'b'], link_depth: 0 })), ['a', 'b']);
});

test('requires must be an array', async () => {
  const { r } = await fresh();
  await assert.rejects(r.recall({ requires: 'voice' }), /requires must be an array/);
  assert.deepEqual(await r.recall(), { memories: [], tokens_used: 0, missing: [], dropped: [] });
});
