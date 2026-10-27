// recall - a tiny memory layer for LLM agents.
//
// Public API:
//   const r = new Recall({ dir })
//   r.write({ name, type, description, decay_class, body, extra })
//   r.get(name)
//   r.list({ type })
//   r.recall({ requires, link_depth = 1, budget_tokens = 2000 })
//   r.dueForReview(asOf = new Date())
//   r.delete(name)

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const DECAY_CLASSES = new Set(['permanent', 'slow', 'fast', 'ephemeral']);
const DECAY_DAYS = { permanent: 365 * 2, slow: 90, fast: 30, ephemeral: 7 };
const RESERVED_KEYS = new Set(['name', 'type', 'description', 'decay_class', 'updated_at']);
const DAY_MS = 1000 * 60 * 60 * 24;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
const LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

const FRONTMATTER_RE = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/;

const isName = name => typeof name === 'string' && SLUG_RE.test(name);
const show = v => (typeof v === 'string' ? JSON.stringify(v) : `(${v === null ? 'null' : typeof v})`);

export class Recall {
  constructor({ dir } = {}) {
    if (!dir) throw new Error('Recall requires a `dir` option');
    this.dir = dir;
  }

  _path(name) {
    if (!isName(name)) {
      throw new Error(`Invalid name ${show(name)}. Must be kebab-case: a-z, 0-9 and "-", starting with a letter or digit, up to 64 chars.`);
    }
    return path.join(this.dir, `${name}.md`);
  }

  async write({ name, type, description = '', decay_class = 'slow', body = '', extra = {} } = {}) {
    const file = this._path(name);
    if (!TYPES.has(type)) throw new Error(`type must be one of ${[...TYPES].join('|')}; got ${show(type)}`);
    if (!DECAY_CLASSES.has(decay_class)) throw new Error(`decay_class must be one of ${[...DECAY_CLASSES].join('|')}; got ${show(decay_class)}`);
    if (typeof description !== 'string') throw new TypeError(`description must be a string; got ${show(description)}`);
    if (typeof body !== 'string') throw new TypeError(`body must be a string; got ${show(body)}`);
    extra ??= {};
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new TypeError('extra must be a plain object');
    for (const key of Object.keys(extra)) {
      if (RESERVED_KEYS.has(key)) throw new Error(`extra.${key} is reserved; write() sets it`);
      if (!KEY_RE.test(key)) throw new Error(`Invalid extra key ${show(key)}. Use letters, digits, "_" and "-".`);
    }

    const now = new Date().toISOString().slice(0, 10);
    const frontmatter = stringifyFrontmatter({
      name, type, description, decay_class, updated_at: now, ...extra,
    });
    const content = `${frontmatter}\n${body.trimEnd()}\n`;

    await fs.mkdir(this.dir, { recursive: true });
    // A unique temp file per write, then an atomic rename: concurrent writers never clobber
    // each other's temp file, and readers see either the old file or the new one.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { name, type, decay_class, updated_at: now };
  }

  async get(name) {
    const file = this._path(name);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    return { name, ...parseFile(raw) };
  }

  async list({ type = null } = {}) {
    let entries;
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    // Only <valid-name>.md files are memories. Anything else (README.md, a MEMORY.md index,
    // "My Notes.md", temp files, folders) is ignored.
    const names = entries
      .filter(e => !e.isDirectory() && e.name.endsWith('.md'))
      .map(e => e.name.slice(0, -3))
      .filter(isName)
      .sort();
    const out = [];
    for (const name of names) {
      const m = await this.get(name);
      if (!m) continue;
      if (type && m.frontmatter.type !== type) continue;
      out.push(m);
    }
    return out;
  }

  async recall({ requires = [], link_depth = 1, budget_tokens = 2000 } = {}) {
    if (!Array.isArray(requires)) throw new TypeError(`requires must be an array of memory names; got ${show(requires)}`);
    const seen = new Set();
    const queue = requires.map(n => [n, 0]);
    const found = [];
    const missing = [];

    // Breadth-first walk over [[wiki-links]].
    for (let i = 0; i < queue.length; i++) {
      const [name, depth] = queue[i];
      if (seen.has(name)) continue;
      seen.add(name);
      const mem = isName(name) ? await this.get(name) : null;
      if (!mem) {
        missing.push(name);
        continue;
      }
      found.push({ mem, depth, order: found.length, tokens: estimateTokens(mem) });
      if (depth < link_depth) {
        for (const link of mem.links) queue.push([link, depth + 1]);
      }
    }

    // Token budget enforcement (rough char/4 estimate). Drop the deepest links first, so required
    // memories go last; at equal depth drop ephemeral, then fast, slow, permanent. Survivors keep walk order.
    let used = found.reduce((s, f) => s + f.tokens, 0);
    const dropped = new Set();
    if (used > budget_tokens) {
      const dropOrder = [...found].sort((a, b) =>
        b.depth - a.depth || decayRank(b.mem) - decayRank(a.mem) || b.order - a.order);
      for (const f of dropOrder) {
        if (used <= budget_tokens) break;
        dropped.add(f);
        used -= f.tokens;
      }
    }

    return {
      memories: found.filter(f => !dropped.has(f)).map(f => f.mem),
      tokens_used: used,
      missing,
      dropped: [...dropped].map(f => f.mem.name),
    };
  }

  async dueForReview(asOf = new Date()) {
    const now = new Date(asOf);
    if (Number.isNaN(now.getTime())) throw new TypeError(`asOf must be a Date or a date string; got ${show(asOf)}`);
    const due = [];
    for (const m of await this.list()) {
      const updated = m.frontmatter.updated_at;
      if (!updated) continue;
      const ageDays = (now - new Date(updated)) / DAY_MS;
      const window = DECAY_DAYS[m.frontmatter.decay_class] ?? DECAY_DAYS.slow;
      if (ageDays >= window) due.push({ ...m, age_days: Math.floor(ageDays) });
    }
    return due;
  }

  async delete(name) {
    try { await fs.unlink(this._path(name)); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
}

// --- helpers ---

function stringifyFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    lines.push(`${k}: ${stringifyValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// Scalars are written bare when YAML reads them back unchanged, otherwise as a JSON string
// (which is also a valid YAML double-quoted string). Arrays and objects are written as JSON,
// which is valid YAML flow syntax.
function stringifyValue(v) {
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (s === '' || s !== s.trim() || /[:#\n\r"']/.test(s) || /^[-?,[\]{}&*!|>%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function parseValue(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v; }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  v = v.replace(/(^|\s)#.*$/, '').trimEnd(); // YAML comment: "slow  # permanent | slow | ..."
  if (v.startsWith('[') || v.startsWith('{')) {
    try { return JSON.parse(v); } catch {}
  }
  return v;
}

function parseFile(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(FRONTMATTER_RE);
  const frontmatter = {};
  for (const line of m?.[1]?.split('\n') ?? []) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    if (!k || k.startsWith('#')) continue;
    frontmatter[k] = parseValue(line.slice(idx + 1).trim());
  }
  const body = (m ? m[2] : text).trimEnd();
  return { frontmatter, body, links: extractLinks(body) };
}

// Unique link targets in first-seen order. Links inside code are examples, not references.
function extractLinks(body) {
  const links = new Set();
  for (const [, inner] of stripCode(body).matchAll(LINK_RE)) {
    const target = inner.split(/\\?\|/)[0].split('#')[0].trim().toLowerCase();
    if (SLUG_RE.test(target)) links.add(target);
  }
  return [...links];
}

// Removes fenced code blocks (``` or ~~~, an unclosed fence runs to the end) and inline `code` spans.
function stripCode(md) {
  const out = [];
  let fence = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line.replace(/(`+)[\s\S]*?\1/g, ''));
  }
  return out.join('\n');
}

function estimateTokens(mem) {
  return Math.ceil((JSON.stringify(mem.frontmatter).length + mem.body.length) / 4);
}

function decayRank(mem) {
  const order = { permanent: 0, slow: 1, fast: 2, ephemeral: 3 };
  return order[mem.frontmatter.decay_class] ?? 1;
}
