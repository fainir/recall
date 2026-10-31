#!/usr/bin/env node
// recall-mcp - serves a recall memory directory as MCP tools over stdio, so any agent that
// speaks MCP (Codex, Cursor, Claude Desktop, ...) reads and writes the same memories.
//
//   recall-mcp                          Claude Code's memory for the current directory's project
//   recall-mcp --claude-code <project>  Claude Code's memory for <project>
//   recall-mcp --dir <dir>              a plain recall directory (add --format claude-code to
//                                       write Claude Code's file format there)
//   --read-only                         list/get/recall/due only; no write or delete tools
//   --allow-secrets                     return memories as stored (by default, keys, tokens and passwords
//                                       in them are replaced with [redacted] before another agent sees them)
//
// Zero dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0.

import { createInterface } from 'node:readline';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Recall } from '../src/index.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `Usage: recall-mcp [--claude-code [project]] [--dir <dir> [--format recall|claude-code]] [--read-only] [--allow-secrets]

Serves memories as MCP tools over stdio. With no options it serves the auto memory Claude Code
keeps for the project in the current directory. Keys, tokens and passwords found in memories are
replaced with [redacted] unless --allow-secrets is given. RECALL_DIR, RECALL_READ_ONLY=1 and
RECALL_ALLOW_SECRETS=1 work too.`;

export function parseArgs(argv, env = process.env) {
  const opts = { mode: null, project: null, dir: null, format: null, readOnly: env.RECALL_READ_ONLY === '1', allowSecrets: env.RECALL_ALLOW_SECRETS === '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === '--claude-code') {
      opts.mode = 'claude-code';
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts.project = argv[++i];
    } else if (a === '--dir') {
      opts.mode = 'dir';
      opts.dir = value();
    } else if (a === '--format') opts.format = value();
    else if (a === '--read-only') opts.readOnly = true;
    else if (a === '--allow-secrets') opts.allowSecrets = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!opts.mode && env.RECALL_DIR) {
    opts.mode = 'dir';
    opts.dir = env.RECALL_DIR;
  }
  if (opts.format && opts.mode !== 'dir') throw new Error('--format only applies with --dir');
  return opts;
}

export function openStore(opts, cwd = process.cwd()) {
  if (opts.mode === 'dir') return new Recall({ dir: opts.dir, format: opts.format ?? 'recall' });
  return Recall.forClaudeCode(opts.project ?? cwd);
}

const TYPE_HELP = 'user: who the person is and how they like to work. feedback: corrections and confirmed approaches. ' +
  'project: ongoing work, decisions and deadlines not in the code. reference: where to find things outside the project.';

const TOOLS = [
  {
    name: 'memory_list',
    description: 'List every saved memory with its type and one-line description. Start here to see what is known.',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Only list memories of this type.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_get',
    description: 'Read one memory in full. Names match file names; "-" and "_" are interchangeable.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Memory name, e.g. feedback_testing.' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_recall',
    description: 'Read the named memories plus the memories they link to with [[wiki-links]], trimmed to a token budget. ' +
      'Unknown names are reported as missing instead of failing.',
    inputSchema: {
      type: 'object',
      properties: {
        requires: { type: 'array', items: { type: 'string' }, description: 'Memory names to start from.' },
        link_depth: { type: 'integer', minimum: 0, description: 'How many [[link]] hops to follow. Default 1.' },
        budget_tokens: { type: 'integer', minimum: 1, description: 'Rough token budget for the result. Default 2000.' },
      },
      required: ['requires'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_due',
    description: 'List memories old enough that they should be re-confirmed with the person before being relied on.',
    inputSchema: {
      type: 'object',
      properties: { as_of: { type: 'string', description: 'ISO date to measure age against. Default now.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'memory_write',
    description: 'Save a memory, or replace the one with the same name. One fact per memory. Save only what a future ' +
      'session could not work out from the code or git history. Never save secrets. ' +
      'Link related memories in the body with [[name]]. ' + TYPE_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase slug: a-z, 0-9, "-" and "_", e.g. feedback_testing.' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        description: { type: 'string', description: 'One line, used to decide relevance later.' },
        body: { type: 'string', description: 'The fact. For feedback and project memories, add **Why:** and **How to apply:** lines.' },
        decay_class: { type: 'string', enum: ['permanent', 'slow', 'fast', 'ephemeral'], description: 'How soon it needs re-confirming. Default slow (90 days).' },
      },
      required: ['name', 'type', 'description', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory that turned out to be wrong or obsolete. Exact name only.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];
const WRITE_TOOLS = new Set(['memory_write', 'memory_delete']);

const describe = m => `${m.name} (${m.type ?? 'untyped'})${m.description ? ` - ${m.description}` : ''}`;

// Claude Code memories sometimes capture a credential from a debugging session ("remember how we fixed
// the staging connection"). Served to another agent, that text goes to another model provider, so
// recognisable secrets are replaced before it leaves. Patterns are specific on purpose: a false
// positive hides a useful fact, a vague pattern would hide many.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{30,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:)([^\s@\/]+)@/gi; // keep scheme and user, hide the password
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/g;

/** Replaces recognisable secrets with [redacted]; returns the text and how many were replaced. */
export function redactSecrets(text) {
  let count = 0;
  const hit = () => { count++; return '[redacted]'; };
  let out = text.replace(URL_PASSWORD, (_, keep) => { count++; return `${keep}[redacted]@`; });
  out = out.replace(BEARER, (_, keep) => { count++; return `${keep}[redacted]`; });
  for (const re of SECRET_PATTERNS) out = out.replace(re, hit);
  return { text: out, count };
}

async function callTool(store, name, args) {
  switch (name) {
    case 'memory_list': {
      const all = await store.list({ type: args.type ?? null });
      if (!all.length) return `No memories yet in ${store.dir}`;
      return `${all.length} memories in ${store.dir}:\n${all.map(m => `- ${describe(m)}`).join('\n')}`;
    }
    case 'memory_get': {
      const m = await store.get(args.name);
      if (!m) return { error: `No memory named ${JSON.stringify(args.name)}. Use memory_list to see the names.` };
      return `# ${describe(m)}\n${m.updated_at ? `updated: ${m.updated_at}\n` : ''}\n${m.body}`;
    }
    case 'memory_recall': {
      const { memories, missing, dropped, tokens_used } = await store.recall(args);
      const parts = memories.map(m => `## ${describe(m)}\n${m.body}`);
      const notes = [`tokens_used: ${tokens_used}`];
      if (missing.length) notes.push(`missing: ${missing.join(', ')}`);
      if (dropped.length) notes.push(`dropped to fit the budget: ${dropped.join(', ')}`);
      return [...parts, notes.join('\n')].join('\n\n');
    }
    case 'memory_due': {
      const due = await store.dueForReview(args.as_of ?? new Date());
      if (!due.length) return 'Nothing is due for review.';
      return due.map(m => `- ${describe(m)} (${m.age_days} days old)`).join('\n');
    }
    case 'memory_write': {
      const r = await store.write(args);
      return `Saved ${r.name} (${r.type}) in ${store.dir}`;
    }
    case 'memory_delete':
      return (await store.delete(args.name)) ? `Deleted ${args.name}` : { error: `No memory named ${JSON.stringify(args.name)}.` };
    default:
      return null;
  }
}

/** Handles one JSON-RPC message. Resolves the response object, or null for notifications. */
export async function handle(msg, { store, readOnly, allowSecrets = false }) {
  const isRequest = msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg;
  const reply = result => (isRequest ? { jsonrpc: '2.0', id: msg.id, result } : null);
  const fail = (code, message) => (isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code, message } } : null);

  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code: -32600, message: 'Invalid request' } };
  }
  const tools = readOnly ? TOOLS.filter(t => !WRITE_TOOLS.has(t.name)) : TOOLS;

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'recall', version: pkg.version },
        instructions: `Long-term memory${store.format === 'claude-code' ? ' shared with Claude Code' : ''} (${store.dir}). ` +
          'Check memory_list at the start of a task ' +
          `and memory_recall what is relevant. ${readOnly ? 'This server is read-only.' : 'Save durable lessons with memory_write.'}`,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (!tools.some(t => t.name === name)) {
        return fail(-32602, readOnly && WRITE_TOOLS.has(name) ? `${name} is disabled: this server is read-only` : `Unknown tool: ${name}`);
      }
      try {
        const out = await callTool(store, name, args);
        let text = typeof out === 'string' ? out : out.error;
        if (!allowSecrets && !WRITE_TOOLS.has(name)) {
          const r = redactSecrets(text);
          if (r.count) text = `${r.text}\n\n(${r.count} secret${r.count === 1 ? '' : 's'} redacted; start recall-mcp with --allow-secrets to return them as stored)`;
        }
        return reply({ content: [{ type: 'text', text }], isError: typeof out !== 'string' });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`recall-mcp: ${e.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const store = openStore(opts);
  process.stderr.write(`recall-mcp ${pkg.version}: ${store.dir}${opts.readOnly ? ' (read-only)' : ''}\n`);

  const send = res => { if (res) process.stdout.write(`${JSON.stringify(res)}\n`); };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Answer in arrival order, one message at a time, so a write is never overtaken by a later read.
  let queue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      send(await handle(msg, { store, readOnly: opts.readOnly, allowSecrets: opts.allowSecrets }));
    });
  });
  rl.on('close', () => { queue.then(() => process.exit(0)); });
}

// Run only when executed (npx and npm link start it through a symlink); tests import handle().
const isMain = (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) main();
