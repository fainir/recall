import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Recall } from '../src/index.js';
import { fresh, missingDir, writeRaw } from './helpers.js';

test('concurrent writes to the same name all succeed and leave one intact file', async () => {
  const { dir, r } = await fresh();
  const bodies = Array.from({ length: 25 }, (_, i) => `version ${i} `.repeat(200).trim());
  await Promise.all(bodies.map(body => r.write({ name: 'hot', type: 'project', body })));
  const got = await r.get('hot');
  assert.ok(bodies.includes(got.body), 'final body is exactly one of the writes');
  assert.deepEqual(await fs.readdir(dir), ['hot.md'], 'no temp files left behind');
});

test('concurrent writes to different names all land', async () => {
  const { r } = await fresh();
  await Promise.all(Array.from({ length: 20 }, (_, i) => r.write({ name: `m${i}`, type: 'user', body: `${i}` })));
  assert.equal((await r.list()).length, 20);
});

test('list skips stray files that are not memories', async () => {
  const { dir, r } = await fresh();
  await r.write({ name: 'real', type: 'user', body: 'x' });
  await writeRaw(dir, 'My Notes.md', 'hand-written');
  await writeRaw(dir, 'README.md', '# readme');
  await writeRaw(dir, 'MEMORY.md', '- index');
  await writeRaw(dir, 'notes.txt', 'not markdown');
  await writeRaw(dir, '.hidden.md', 'dotfile');
  await fs.mkdir(path.join(dir, 'folder.md'));
  assert.deepEqual((await r.list()).map(m => m.name), ['real']);
  assert.deepEqual(await r.dueForReview(), []);
});

test('list returns memories sorted by name', async () => {
  const { r } = await fresh();
  for (const name of ['zeta', 'alpha', 'mid', '10-ten', '2-two']) {
    await r.write({ name, type: 'user', body: name });
  }
  assert.deepEqual((await r.list()).map(m => m.name), ['10-ten', '2-two', 'alpha', 'mid', 'zeta']);
});

test('reads on a missing directory return empty results and do not create it', async () => {
  const dir = await missingDir();
  const r = new Recall({ dir });
  assert.equal(await r.get('anything'), null);
  assert.deepEqual(await r.list(), []);
  assert.deepEqual(await r.dueForReview(), []);
  assert.deepEqual((await r.recall({ requires: ['a'] })).memories, []);
  assert.equal(await r.delete('anything'), false);
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
});

test('write creates missing (nested) directories', async () => {
  const dir = await missingDir();
  const r = new Recall({ dir });
  await r.write({ name: 'first', type: 'user', body: 'hello' });
  assert.equal((await r.get('first')).body, 'hello');
});

test('an invalid write does not create the directory', async () => {
  const dir = await missingDir();
  const r = new Recall({ dir });
  await assert.rejects(r.write({ name: 'x', type: 'bogus' }));
  await assert.rejects(r.write({ name: '../x', type: 'user' }));
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
});

test('write overwrites an existing memory and refreshes updated_at', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'note.md', '---\nname: note\ntype: user\nupdated_at: 2020-01-01\n---\nold\n');
  const res = await r.write({ name: 'note', type: 'user', body: 'new' });
  const got = await r.get('note');
  assert.equal(got.body, 'new');
  assert.equal(got.frontmatter.updated_at, res.updated_at);
  assert.notEqual(res.updated_at, '2020-01-01');
});
