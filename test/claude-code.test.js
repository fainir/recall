import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Recall, claudeCodeMemoryDir } from '../src/index.js';
import { fresh, writeRaw } from './helpers.js';

// The shape Claude Code writes today, and the flat shape older versions wrote.
const NESTED = `---
name: feedback_testing
description: run the integration tests before claiming done
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5b0c1f2e-0000-4000-8000-000000000000
  modified: 2026-09-01T10:00:00.000Z
---

Run \`npm run test:int\`, not just unit tests.
**Why:** unit tests mock the database.
See [[reference_ci_dashboard]] and [[project-launch]].
`;

const FLAT = `---
name: Reference CI dashboard
description: where CI runs live
type: reference
---
https://ci.example.com/acme
`;

async function ccFixture() {
  const { dir } = await fresh();
  await writeRaw(dir, 'feedback_testing.md', NESTED);
  await writeRaw(dir, 'reference_ci_dashboard.md', FLAT);
  await writeRaw(dir, 'MEMORY.md', '- [Testing](feedback_testing.md) - run integration tests\n');
  return { dir, r: new Recall({ dir, format: 'claude-code' }) };
}

test('reads Claude Code memories: nested metadata, flat legacy files, underscores', async () => {
  const { r } = await ccFixture();
  const all = await r.list();
  assert.deepEqual(all.map(m => m.name), ['feedback_testing', 'reference_ci_dashboard']);

  const fb = await r.get('feedback_testing');
  assert.equal(fb.type, 'feedback');
  assert.equal(fb.description, 'run the integration tests before claiming done');
  assert.equal(fb.updated_at, '2026-09-01T10:00:00.000Z');
  assert.equal(fb.frontmatter.metadata.originSessionId, '5b0c1f2e-0000-4000-8000-000000000000');
  assert.deepEqual(fb.links, ['reference_ci_dashboard', 'project-launch']);
  assert.ok(fb.body.startsWith('Run `npm run test:int`'), 'the blank line after the frontmatter is not part of the body');

  assert.equal((await r.get('reference_ci_dashboard')).type, 'reference');
  assert.deepEqual((await r.list({ type: 'reference' })).map(m => m.name), ['reference_ci_dashboard']);
});

test('MEMORY.md is never listed as a memory', async () => {
  const { r } = await ccFixture();
  assert.ok(!(await r.list()).some(m => m.name === 'MEMORY'));
});

test('links resolve across "-" and "_" spellings and by frontmatter name', async () => {
  const { dir, r } = await ccFixture();
  assert.equal((await r.get('reference-ci-dashboard')).name, 'reference_ci_dashboard');
  await writeRaw(dir, 'p1.md', '---\nname: project-launch\ntype: project\n---\nlaunch is on the 3rd');
  assert.equal((await r.get('project-launch')).name, 'p1');

  const slice = await r.recall({ requires: ['feedback-testing'] });
  assert.deepEqual(slice.memories.map(m => m.name), ['feedback_testing', 'reference_ci_dashboard', 'p1']);
  assert.deepEqual(slice.missing, []);
});

test('a memory reached under two spellings is returned once', async () => {
  const { r } = await ccFixture();
  const slice = await r.recall({ requires: ['reference_ci_dashboard', 'reference-ci-dashboard'] });
  assert.deepEqual(slice.memories.map(m => m.name), ['reference_ci_dashboard']);
});

test('write() in claude-code format produces the file Claude Code writes, and indexes it', async () => {
  const { dir } = await fresh();
  const r = new Recall({ dir, format: 'claude-code' });
  await r.write({ name: 'user_role', type: 'user', description: 'senior engineer: prefers terse answers', body: 'Terse. No preamble.' });

  const raw = await fs.readFile(path.join(dir, 'user_role.md'), 'utf8');
  const lines = raw.split('\n');
  assert.deepEqual(lines.slice(0, 5), [
    '---', 'name: user_role', 'description: "senior engineer: prefers terse answers"', 'metadata:', '  node_type: memory',
  ]);
  assert.equal(lines[5], '  type: user');
  assert.match(lines[6], /^ {2}modified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(lines.slice(7), ['---', '', 'Terse. No preamble.', '']);
  assert.ok(!raw.includes('decay_class'), 'the default decay class is not written');
  assert.ok(!raw.includes('updated_at'));

  const got = await r.get('user_role');
  assert.equal(got.type, 'user');
  assert.equal(got.body, 'Terse. No preamble.');

  assert.equal(await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8'),
    '- [user_role](user_role.md) - senior engineer: prefers terse answers\n');
});

test('overwriting keeps fields recall does not own and moves legacy flat fields under metadata', async () => {
  const { dir, r } = await ccFixture();
  await r.write({ name: 'feedback_testing', type: 'feedback', description: 'updated', body: 'new body' });
  const fb = await r.get('feedback_testing');
  assert.equal(fb.frontmatter.metadata.originSessionId, '5b0c1f2e-0000-4000-8000-000000000000');
  assert.notEqual(fb.updated_at, '2026-09-01T10:00:00.000Z');

  await writeRaw(dir, 'legacy.md', '---\nname: legacy\ntype: project\noriginSessionId: abc\n---\nold');
  await r.write({ name: 'legacy', type: 'project', body: 'new' });
  const legacy = await r.get('legacy');
  assert.equal(legacy.frontmatter.type, undefined);
  assert.equal(legacy.frontmatter.metadata.type, 'project');
  assert.equal(legacy.frontmatter.metadata.originSessionId, 'abc');
});

test('writing under the other spelling updates the existing file instead of duplicating it', async () => {
  const { dir, r } = await ccFixture();
  await r.write({ name: 'feedback-testing', type: 'feedback', description: 'respelled', body: 'one file' });
  const files = (await fs.readdir(dir)).filter(f => f.startsWith('feedback'));
  assert.deepEqual(files, ['feedback_testing.md']);
  assert.equal((await r.get('feedback_testing')).body, 'one file');
});

test('MEMORY.md: existing lines are kept, a rewrite replaces its own line, delete removes it', async () => {
  const { dir, r } = await ccFixture();
  const index = () => fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8');
  await r.write({ name: 'feedback_testing', type: 'feedback', description: 'new hook\nwith a newline', body: 'x' });
  assert.equal(await index(), '- [feedback_testing](feedback_testing.md) - new hook with a newline\n');

  await r.write({ name: 'project_launch', type: 'project', body: 'y' });
  assert.equal(await index(), '- [feedback_testing](feedback_testing.md) - new hook with a newline\n- [project_launch](project_launch.md)\n');

  assert.equal(await r.delete('feedback_testing'), true);
  assert.equal(await index(), '- [project_launch](project_launch.md)\n');
  assert.equal(await r.delete('feedback_testing'), false);
});

test('recall format is unchanged and never touches MEMORY.md', async () => {
  const { dir, r } = await fresh();
  await r.write({ name: 'voice', type: 'user', body: 'terse' });
  const raw = await fs.readFile(path.join(dir, 'voice.md'), 'utf8');
  assert.match(raw, /^---\nname: voice\ntype: user\ndescription: ""\ndecay_class: slow\nupdated_at: \d{4}-\d{2}-\d{2}\n---\nterse\n$/);
  await assert.rejects(fs.access(path.join(dir, 'MEMORY.md')));
});

test('dueForReview uses Claude Code\'s modified timestamp', async () => {
  const { r } = await ccFixture();
  const due = await r.dueForReview(new Date('2026-12-15'));
  assert.deepEqual(due.map(m => [m.name, m.age_days]), [['feedback_testing', 104]]);
});

test('values with ":", "#" and URLs round-trip; URLs stay unquoted', async () => {
  const { dir } = await fresh();
  const r = new Recall({ dir, format: 'claude-code' });
  const values = ['a:b', 'see: the docs', 'ends with:', 'issue #12', '#tag first', 'https://ci.example.com/a?b=c#d', 'C:\\path'];
  for (const [i, description] of values.entries()) {
    await r.write({ name: `v${i}`, type: 'reference', description, body: 'x' });
    assert.equal((await r.get(`v${i}`)).description, description, description);
  }
  const raw = await fs.readFile(path.join(dir, 'v5.md'), 'utf8');
  assert.match(raw, /^description: https:\/\/ci\.example\.com\/a\?b=c#d$/m);
});

test('an unknown format is rejected', () => {
  assert.throws(() => new Recall({ dir: '/tmp/x', format: 'yaml' }), /format must be one of/);
});

// --- where Claude Code keeps the memory ---

const HOME = '/home/tester';
const ccDir = (p, env = {}) => claudeCodeMemoryDir(p, { env, home: HOME });

test('claudeCodeMemoryDir: folder name rule outside git, on the physical path', async () => {
  const { dir } = await fresh();
  const real = await fs.realpath(dir);
  const expected = path.join(HOME, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  assert.equal(ccDir(real), expected);
  // A symlink to the project resolves to the same memory, as Claude Code's working directory would.
  const link = path.join(real, '..', `${path.basename(real)}-link`);
  await fs.symlink(real, link);
  try {
    assert.equal(ccDir(link), expected);
  } finally {
    await fs.rm(link);
  }
});

test('claudeCodeMemoryDir: long paths are cut at 200 chars plus a hash, like Claude Code', () => {
  const long = `/Users/x/${'deep/'.repeat(50)}project`;
  const name = path.basename(path.dirname(ccDir(long)));
  assert.equal(name.length > 200, true);
  assert.match(name, /^.{200}-[0-9a-z]+$/);
  // Same algorithm as Claude Code's own (a Java-style string hash in base 36).
  let h = 0;
  for (let i = 0; i < long.length; i++) h = ((h << 5) - h + long.charCodeAt(i)) | 0;
  assert.equal(name.slice(201), Math.abs(h).toString(36));
});

test('claudeCodeMemoryDir: subfolders and worktrees share the repository\'s memory', async () => {
  const { dir } = await fresh();
  const repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, 'src', 'deep'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', path.join(dir, 'wt'));

  const repoReal = await fs.realpath(repo);
  const main = ccDir(repoReal);
  assert.equal(ccDir(path.join(repoReal, 'src', 'deep')), main);
  assert.equal(ccDir(path.join(await fs.realpath(dir), 'wt')), main);
});

test('claudeCodeMemoryDir: CLAUDE_CONFIG_DIR, CLAUDE_CODE_PROJECT_DIR_NAME and autoMemoryDirectory', async () => {
  const { dir } = await fresh();
  assert.equal(ccDir(dir, { CLAUDE_CONFIG_DIR: '/cfg' }).startsWith('/cfg/projects/'), true);
  assert.equal(ccDir(dir, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_PROJECT_DIR_NAME: 'shared' }), '/cfg/projects/shared/memory');
  // The project-dir name only applies next to CLAUDE_CONFIG_DIR.
  assert.equal(ccDir(dir, { CLAUDE_CODE_PROJECT_DIR_NAME: 'shared' }).includes('/shared/'), false);

  await fs.mkdir(path.join(dir, '.claude'));
  await writeRaw(path.join(dir, '.claude'), 'settings.local.json', JSON.stringify({ autoMemoryDirectory: '~/notes/mem/' }));
  assert.equal(ccDir(dir), path.join(HOME, 'notes', 'mem'));
  await writeRaw(path.join(dir, '.claude'), 'settings.local.json', JSON.stringify({ autoMemoryDirectory: 'relative/is-ignored' }));
  assert.equal(ccDir(dir).startsWith(path.join(HOME, '.claude', 'projects')), true);
});

test('Recall.forClaudeCode points at that directory in claude-code format', async () => {
  const { dir } = await fresh();
  const r = Recall.forClaudeCode(dir, { env: { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') } });
  assert.equal(r.format, 'claude-code');
  assert.equal(r.dir, path.join(dir, 'cfg', 'projects', (await fs.realpath(dir)).replace(/[^a-zA-Z0-9]/g, '-'), 'memory'));
});
