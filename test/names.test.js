import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Recall } from '../src/index.js';
import { fresh } from './helpers.js';

const UNSAFE = [
  '../evil', '../../etc/passwd', 'a/b', 'a\\b', '.hidden', 'x.md', '',
  'a'.repeat(65), 'voice\n', 'a\0b', 'Voice', 'has space', '-leading',
  'café', '日本語',
];

test('write/get/delete reject path traversal and unsafe names', async () => {
  const { dir, r } = await fresh();
  for (const name of UNSAFE) {
    await assert.rejects(r.write({ name, type: 'user' }), /Invalid name/, `write ${JSON.stringify(name)}`);
    await assert.rejects(r.get(name), /Invalid name/, `get ${JSON.stringify(name)}`);
    await assert.rejects(r.delete(name), /Invalid name/, `delete ${JSON.stringify(name)}`);
  }
  assert.deepEqual(await fs.readdir(dir), []);
  await assert.rejects(fs.access(path.join(dir, '..', 'evil.md')));
});

test('non-string names are rejected instead of becoming "undefined.md"', async () => {
  const { dir, r } = await fresh();
  // An object whose toString() passes validation once, then turns into a traversal.
  const sneaky = () => {
    let calls = 0;
    return { toString: () => (calls++ === 0 ? 'ok' : '../escaped') };
  };
  for (const name of [undefined, null, 123, sneaky()]) {
    await assert.rejects(r.write({ name, type: 'user', body: 'x' }), /Invalid name/);
  }
  for (const name of [undefined, null, 123, sneaky()]) {
    await assert.rejects(r.get(name), /Invalid name/);
    await assert.rejects(r.delete(name), /Invalid name/);
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('64-char names are accepted', async () => {
  const { r } = await fresh();
  const name = 'a'.repeat(64);
  await r.write({ name, type: 'user', body: 'long' });
  assert.equal((await r.get(name)).body, 'long');
});

test('unicode content round-trips (names stay ASCII slugs)', async () => {
  const { r } = await fresh();
  const description = 'Café notes - 日本語 - שלום';
  const body = 'Ünïcödé body with emoji \u{1F600} and RTL שלום';
  await r.write({ name: 'unicode', type: 'reference', description, body });
  const got = await r.get('unicode');
  assert.equal(got.frontmatter.description, description);
  assert.equal(got.body, body);
});

test('constructor without options gives a clear error', () => {
  assert.throws(() => new Recall(), /requires a `dir` option/);
  assert.throws(() => new Recall({}), /requires a `dir` option/);
});
