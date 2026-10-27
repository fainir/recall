import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.js';

async function linksOf(body) {
  const { r } = await fresh();
  await r.write({ name: 'src', type: 'reference', body });
  return (await r.get('src')).links;
}

test('alias and heading links resolve to the target name', async () => {
  assert.deepEqual(
    await linksOf('[[alpha|Alpha Co]] [[beta#Renewal]] [[gamma#h|label]] [[ delta ]] [[eps\\|table-alias]]'),
    ['alpha', 'beta', 'gamma', 'delta', 'eps'],
  );
});

test('links are case-insensitive (slugs are lowercase)', async () => {
  assert.deepEqual(await linksOf('see [[Top-Customers]] and [[VOICE]]'), ['top-customers', 'voice']);
});

test('duplicate links are reported once, in first-seen order', async () => {
  assert.deepEqual(await linksOf('[[b]] [[a]] [[b]] [[A]] [[b|again]]'), ['b', 'a']);
});

test('links inside fenced code blocks and inline code are ignored', async () => {
  const body = [
    'real: [[kept]]',
    '```js',
    "const s = '[[in-fence]]';",
    '```',
    '~~~',
    '[[in-tilde-fence]]',
    '~~~',
    'inline `[[in-code]]` and ``double `[[in-double]]` ticks`` then [[also-kept]]',
    '````md',
    '```',
    '[[in-nested-fence]]',
    '```',
    '````',
    'after: [[last]]',
  ].join('\n');
  assert.deepEqual(await linksOf(body), ['kept', 'also-kept', 'last']);
});

test('an unclosed fence hides links until the end of the body', async () => {
  assert.deepEqual(await linksOf('[[before]]\n```\n[[inside]]\n'), ['before']);
});

test('targets that are not valid names are ignored', async () => {
  assert.deepEqual(
    await linksOf('[[Some Page]] [[../etc/passwd]] ![[image.png]] [[]] [[café]] [[ok-1]]'),
    ['ok-1'],
  );
});

test('recall follows alias, heading and mixed-case links', async () => {
  const { r } = await fresh();
  await r.write({ name: 'hub', type: 'project', body: '[[a|A]] [[B#section]] `[[c]]`' });
  await r.write({ name: 'a', type: 'project', body: 'a' });
  await r.write({ name: 'b', type: 'project', body: 'b' });
  await r.write({ name: 'c', type: 'project', body: 'c' });
  const out = await r.recall({ requires: ['hub'] });
  assert.deepEqual(out.memories.map(m => m.name), ['hub', 'a', 'b']);
});
