import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recall } from '../src/index.js';
import { handle, parseArgs, redactSecrets } from '../bin/recall-mcp.js';
import { fresh } from './helpers.js';

// Synthetic look-alikes built at run time, so no real-looking secret sits in the repository.
const rep = (c, n) => c.repeat(n);
const keyFixture = (label, contents) => `-----BEGIN ${label}-----\n${contents}\n-----END ${label}-----`;
const SAMPLES = {
  anthropic: `sk-ant-api03-${rep('a', 40)}`,
  openai: `sk-proj-${rep('B', 40)}`,
  github: `ghp_${rep('c', 36)}`,
  githubPat: `github_pat_${rep('D', 40)}`,
  slack: `xoxb-${rep('1', 12)}-${rep('e', 12)}`,
  aws: `AKIA${rep('F', 16)}`,
  google: `AIza${rep('g', 35)}`,
  stripe: `sk_live_${rep('h', 24)}`,
  jwt: `eyJ${rep('i', 20)}.eyJ${rep('j', 20)}.${rep('k', 20)}`,
};

test('redactSecrets: replaces each recognised kind of secret', () => {
  for (const [kind, secret] of Object.entries(SAMPLES)) {
    const { text, count } = redactSecrets(`the ${kind} key is ${secret} for staging`);
    assert.equal(count, 1, kind);
    assert.equal(text, `the ${kind} key is [redacted] for staging`, kind);
  }
});

test('redactSecrets: hides the password in a URL, keeps scheme, user and host', () => {
  const { text, count } = redactSecrets('DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/main');
  assert.equal(count, 1);
  assert.equal(text, 'DATABASE_URL=postgres://app:[redacted]@db.internal:5432/main');
});

test('redactSecrets: hides bearer tokens and private key blocks', () => {
  const bearer = redactSecrets(`curl -H "Authorization: Bearer ${rep('t', 32)}" https://api.example.com`);
  assert.equal(bearer.text, 'curl -H "Authorization: Bearer [redacted]" https://api.example.com');
  const key = redactSecrets(['before', keyFixture('OPENSSH PRIVATE KEY', rep('m', 64)), 'after'].join('\n'));
  assert.equal(key.text, 'before\n[redacted]\nafter');
});

test('redactSecrets: masks named environment values in notes and preserves surrounding text', () => {
  const note = [
    'DB_PASSWORD=fictional-password # local fixture',
    'export SERVICE_API_TOKEN = "fictional token with a # and ="',
    "Use `CLIENT_SECRET='fictional key'` on staging.",
    'Run API_KEY=fictional\\ value npm test.',
    'AUTH_TOKEN="truncated fictional token',
    `GITHUB_TOKEN=${SAMPLES.github}`,
    'Set (DB_PASSWORD=fictional) before [[reference_ci]].',
    "export SERVICE_TOKEN='fictional'&&npm run smoke",
    'PRIVATE_KEY="fictional line one\nfictional line two"',
    "CLIENT_SECRET='fictional other line one\nfictional other line two'",
    '**DB_PASSWORD=fictional**',
    'DB_PASSWORD= SERVICE_TOKEN=fictional next',
    'Use `CLIENT_SECRET="truncated sample` beside [[reference_ci]].',
    'Use `DB_PASSWORD="truncated` or `SERVICE_TOKEN="fictional token"`.',
    'SERVICE_TOKEN="fictional first\\\r\nsecond part"',
    'APP_SECRET=fictional-\\\nsecond-part; npm run smoke',
    'Read [DB_PASSWORD=fictional](https://example.test/setup).',
  ].join('\r\n');
  assert.deepEqual(redactSecrets(note), {
    text: [
      'DB_PASSWORD=[redacted] # local fixture',
      'export SERVICE_API_TOKEN = [redacted]',
      'Use `CLIENT_SECRET=[redacted]` on staging.',
      'Run API_KEY=[redacted] npm test.',
      'AUTH_TOKEN=[redacted]',
      'GITHUB_TOKEN=[redacted]',
      'Set (DB_PASSWORD=[redacted]) before [[reference_ci]].',
      'export SERVICE_TOKEN=[redacted]&&npm run smoke',
      'PRIVATE_KEY=[redacted]',
      'CLIENT_SECRET=[redacted]',
      '**DB_PASSWORD=[redacted]**',
      'DB_PASSWORD= SERVICE_TOKEN=[redacted] next',
      'Use `CLIENT_SECRET=[redacted]` beside [[reference_ci]].',
      'Use `DB_PASSWORD=[redacted]` or `SERVICE_TOKEN=[redacted]`.',
      'SERVICE_TOKEN=[redacted]',
      'APP_SECRET=[redacted]; npm run smoke',
      'Read [DB_PASSWORD=[redacted]](https://example.test/setup).',
    ].join('\r\n'),
    count: 18,
  });
});

test('redactSecrets: counts a private key block in an assignment once', () => {
  const body = `PRIVATE_KEY="${keyFixture('PRIVATE KEY', 'fictional-key-bytes')}"`;
  assert.deepEqual(redactSecrets(body), { text: 'PRIVATE_KEY="[redacted]"', count: 1 });
  const spaced = 'PRIVATE_KEY="\n' + keyFixture('PRIVATE KEY', 'fictional-key-bytes') + '\n"';
  assert.deepEqual(redactSecrets(spaced), { text: 'PRIVATE_KEY="\n[redacted]\n"', count: 1 });
});

test('redactSecrets: leaves ordinary memories alone', () => {
  const plain = [
    'Run `npm run test:int` (needs the local Postgres from docker compose), not just `npm test`.',
    'See https://github.com/fainir/recall and [[reference_ci]]. Use sk-ant model ids from the docs.',
    'postgres://localhost:5432/main has no password; task-1234 is the ticket; skill_name_here stays.',
    'APP_PORT=5432 SERVICE_TOKEN_REQUIRED=true',
    'DB_PASSWORD=\nSERVICE_TOKEN=""\nPRIVATE_KEY=[redacted]',
    'DB_PASSWORD= # intentionally empty',
    'DB_PASSWORD= APP_PORT=5432',
  ].join('\n');
  assert.deepEqual(redactSecrets(plain), { text: plain, count: 0 });
});

async function server(opts = {}) {
  const { dir } = await fresh();
  const store = new Recall({ dir, format: 'claude-code' });
  await store.write({ name: 'project_staging', type: 'project', description: 'How staging connects',
    body: `We fixed staging with DATABASE_URL=postgres://app:hunter2secret@db:5432/main and key ${SAMPLES.anthropic}. See [[reference_ci]].` });
  await store.write({ name: 'reference_ci', type: 'reference', description: 'CI notes', body: 'CI runs on every push.' });
  let id = 1;
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }, { store, ...opts }))
    .result.content.map(c => c.text).join('');
  return { call };
}

test('MCP: memory_get and memory_recall redact by default and say so', async () => {
  const { call } = await server();
  for (const out of [await call('memory_get', { name: 'project_staging' }), await call('memory_recall', { requires: ['project_staging'] })]) {
    assert.doesNotMatch(out, /hunter2secret|sk-ant-api03/);
    assert.match(out, /postgres:\/\/app:\[redacted\]@db:5432\/main/);
    assert.match(out, /2 secrets redacted; start recall-mcp with --allow-secrets/);
  }
  assert.match(await call('memory_recall', { requires: ['project_staging'] }), /CI runs on every push/); // links still followed
});

test('MCP: --allow-secrets returns memories as stored', async () => {
  const { call } = await server({ allowSecrets: true });
  const out = await call('memory_get', { name: 'project_staging' });
  assert.match(out, /hunter2secret/);
  assert.doesNotMatch(out, /redacted/);
});

test('MCP: named environment values are masked in read-only tool results', async () => {
  const { dir } = await fresh();
  const store = new Recall({ dir, format: 'claude-code' });
  const description = 'Setup uses DEPLOY_TOKEN=fictional-deploy-token before activation.';
  const body = 'DB_PASSWORD=fictional-db-password\nSee [[reference_ci]].';
  await store.write({ name: 'project_env', type: 'project', description, body });
  await store.write({ name: 'reference_ci', type: 'reference', description: 'CI notes', body: 'Run the fixture.' });
  const call = async (name, args = {}, allowSecrets = false) => {
    const out = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { store, readOnly: true, allowSecrets });
    assert.equal(out.result.isError, false);
    return out.result.content[0].text;
  };
  for (const out of [await call('memory_list'), await call('memory_due', { as_of: '2100-01-01' })]) {
    assert.match(out, /DEPLOY_TOKEN=\[redacted\] before activation\./);
    assert.doesNotMatch(out, /fictional-deploy-token/);
  }
  const get = await call('memory_get', { name: 'project_env' });
  const recall = await call('memory_recall', { requires: ['project_env'] });
  for (const out of [get, recall]) {
    assert.match(out, /DEPLOY_TOKEN=\[redacted\]/);
    assert.match(out, /DB_PASSWORD=\[redacted\]/);
    assert.match(out, /2 secrets redacted/);
    assert.doesNotMatch(out, /fictional-(?:deploy-token|db-password)/);
  }
  assert.match(recall, /Run the fixture\./);
  assert.match(await call('memory_get', { name: 'project_env' }, true), /fictional-db-password/);
  const original = await store.get('project_env');
  assert.equal(original.body.trim(), body);
  assert.equal(original.description, description);
});

test('parseArgs: --allow-secrets and RECALL_ALLOW_SECRETS=1', () => {
  assert.equal(parseArgs([], {}).allowSecrets, false);
  assert.equal(parseArgs(['--allow-secrets'], {}).allowSecrets, true);
  assert.equal(parseArgs([], { RECALL_ALLOW_SECRETS: '1' }).allowSecrets, true);
});
