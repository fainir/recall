import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fresh, writeRaw } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

test('CRLF line endings keep their frontmatter', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'crlf.md', '---\r\nname: crlf\r\ntype: user\r\ndecay_class: fast\r\n---\r\nline one\r\nline two\r\n');
  const got = await r.get('crlf');
  assert.equal(got.frontmatter.type, 'user');
  assert.equal(got.frontmatter.decay_class, 'fast');
  assert.equal(got.body, 'line one\nline two');
});

test('a UTF-8 BOM does not hide the frontmatter', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'bom.md', '﻿---\nname: bom\ntype: project\n---\nbody');
  const got = await r.get('bom');
  assert.equal(got.frontmatter.type, 'project');
  assert.equal(got.body, 'body');
});

test('YAML comments after values are ignored (README file format example)', async () => {
  const { dir, r } = await fresh();
  const old = new Date(Date.now() - 100 * DAY).toISOString().slice(0, 10);
  await writeRaw(dir, 'top-customers.md', [
    '---',
    'name: top-customers',
    'type: project',
    'description: paying customers above $10K ACV',
    'decay_class: slow      # permanent | slow | fast | ephemeral',
    `updated_at: ${old}`,
    '---',
    '',
    '- AcmeCorp - $18K ACV across 6 child accounts (see [[acmecorp-parent]])',
    '',
  ].join('\n'));
  const got = await r.get('top-customers');
  assert.equal(got.frontmatter.decay_class, 'slow');
  assert.deepEqual(got.links, ['acmecorp-parent']);
  const due = await r.dueForReview();
  assert.deepEqual(due.map(m => m.name), ['top-customers']);
});

test('tricky string values round-trip exactly', async () => {
  const { r } = await fresh();
  const values = [
    '  padded  ', 'key: value', 'has # hash', 'say "hi"', "it's", 'multi\nline',
    'fake\n---\nfrontmatter', '[draft] notes', '{braces}', '- dash', '*star', '&anchor',
    '!tag', '|pipe', '>gt', '@at', '`tick`', 'back\\slash', 'tab\there', 'cr\rhere',
  ];
  for (const [i, description] of values.entries()) {
    await r.write({ name: `v${i}`, type: 'reference', description, body: 'b' });
    const got = await r.get(`v${i}`);
    assert.equal(got.frontmatter.description, description, `value ${JSON.stringify(description)}`);
    assert.equal(got.body, 'b');
  }
});

test('values YAML would misread are written quoted', async () => {
  const { dir, r } = await fresh();
  await r.write({ name: 'q', type: 'user', description: '[draft] notes', extra: { note: '  x', empty: '' } });
  const raw = await fs.readFile(path.join(dir, 'q.md'), 'utf8');
  assert.match(raw, /^description: "\[draft\] notes"$/m);
  assert.match(raw, /^note: " {2}x"$/m);
  assert.match(raw, /^empty: ""$/m);
  assert.doesNotMatch(raw, / +$/m, 'no trailing whitespace');
});

test('body round-trips exactly (minus trailing whitespace)', async () => {
  const { r } = await fresh();
  const body = '\n  indented first line\n\n---\nnot: frontmatter\n---\n\nlast line';
  await r.write({ name: 'body', type: 'user', body: body + '\n\n  ' });
  assert.equal((await r.get('body')).body, body);
});

test('extra: arrays and objects round-trip instead of becoming "[object Object]"', async () => {
  const { r } = await fresh();
  const extra = { tags: ['a', 'b c', 'd: e'], meta: { source: 'slack', n: 2 }, score: 5 };
  await r.write({ name: 'extra', type: 'project', body: 'x', extra });
  const fm = (await r.get('extra')).frontmatter;
  assert.deepEqual(fm.tags, extra.tags);
  assert.deepEqual(fm.meta, extra.meta);
  assert.equal(fm.score, '5', 'scalars come back as strings');
});

test('extra cannot override reserved fields', async () => {
  const { dir, r } = await fresh();
  for (const key of ['name', 'type', 'description', 'decay_class', 'updated_at']) {
    await assert.rejects(
      r.write({ name: 'x', type: 'user', extra: { [key]: 'bogus' } }),
      new RegExp(`extra\\.${key}`),
    );
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('extra keys that would corrupt the frontmatter are rejected', async () => {
  const { r } = await fresh();
  for (const key of ['a\n---\nevil', 'a: b', '', ' lead', '#c']) {
    await assert.rejects(r.write({ name: 'x', type: 'user', extra: { [key]: 1 } }), /Invalid extra key/);
  }
});

test('single-quoted hand-written values are unquoted', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'sq.md', "---\nname: sq\ntype: user\ndescription: 'it''s quoted'\n---\nbody\n");
  assert.equal((await r.get('sq')).frontmatter.description, "it's quoted");
});

test('an empty frontmatter block is still frontmatter', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'empty.md', '---\n---\nbody here\n');
  const got = await r.get('empty');
  assert.deepEqual(got.frontmatter, {});
  assert.equal(got.body, 'body here');
});

test('files without frontmatter still get a name (from the file name)', async () => {
  const { dir, r } = await fresh();
  await writeRaw(dir, 'plain.md', 'just a note, see [[other]]\n');
  const got = await r.get('plain');
  assert.equal(got.name, 'plain');
  assert.equal(got.body, 'just a note, see [[other]]');
  assert.deepEqual(got.links, ['other']);
  assert.deepEqual((await r.list()).map(m => m.name), ['plain']);
});

test('unknown decay_class is treated as slow by dueForReview', async () => {
  const { dir, r } = await fresh();
  const old = new Date(Date.now() - 100 * DAY).toISOString().slice(0, 10);
  await writeRaw(dir, 'odd.md', `---\nname: odd\ntype: user\ndecay_class: sometimes\nupdated_at: ${old}\n---\nx\n`);
  assert.deepEqual((await r.dueForReview()).map(m => m.name), ['odd']);
});

test('dueForReview accepts a date string and rejects garbage', async () => {
  const { r } = await fresh();
  await r.write({ name: 'fresh', type: 'user', decay_class: 'fast', body: 'x' });
  const later = new Date(Date.now() + 40 * DAY).toISOString();
  assert.deepEqual((await r.dueForReview(later)).map(m => m.name), ['fresh']);
  assert.deepEqual(await r.dueForReview(), []);
  await assert.rejects(r.dueForReview('not a date'), /asOf/);
});

test('write rejects a non-string body or description with a clear error', async () => {
  const { r } = await fresh();
  await assert.rejects(r.write({ name: 'x', type: 'user', body: null }), /body must be a string/);
  await assert.rejects(r.write({ name: 'x', type: 'user', body: { a: 1 } }), /body must be a string/);
  await assert.rejects(r.write({ name: 'x', type: 'user', description: ['a'] }), /description must be a string/);
});

test('write error messages name the bad value', async () => {
  const { r } = await fresh();
  await assert.rejects(r.write({ name: 'x', type: 'bogus' }), /got "bogus"/);
  await assert.rejects(r.write({ name: 'x', type: 'user', decay_class: 'forever' }), /got "forever"/);
});
