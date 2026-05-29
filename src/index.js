// recall - a tiny memory layer for LLM agents.
//
// Public API:
//   const r = new Recall({ dir })
//   r.write({ name, type, description, decay_class, body })
//   r.get(name)
//   r.list({ type })
//   r.recall({ requires, link_depth = 1, budget_tokens = 2000 })
//   r.dueForReview(asOf = new Date())
//   r.delete(name)

import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const DECAY_CLASSES = new Set(['permanent', 'slow', 'fast', 'ephemeral']);
const DECAY_DAYS = { permanent: 365 * 2, slow: 90, fast: 30, ephemeral: 7 };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const LINK_RE = /\[\[([a-z0-9-]+)\]\]/g;

export class Recall {
  constructor({ dir }) {
    if (!dir) throw new Error('Recall requires a `dir` option');
    this.dir = dir;
  }

  async _ensure() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _path(name) {
    if (!SLUG_RE.test(name)) throw new Error(`Invalid name "${name}". Must be kebab-case, [a-z0-9-], up to 64 chars.`);
    return path.join(this.dir, `${name}.md`);
  }

  async write({ name, type, description = '', decay_class = 'slow', body = '', extra = {} }) {
    await this._ensure();
    if (!TYPES.has(type)) throw new Error(`type must be one of ${[...TYPES].join('|')}`);
    if (!DECAY_CLASSES.has(decay_class)) throw new Error(`decay_class must be one of ${[...DECAY_CLASSES].join('|')}`);

    const now = new Date().toISOString().slice(0, 10);
    const frontmatter = stringifyFrontmatter({
      name, type, description, decay_class, updated_at: now, ...extra,
    });
    const file = `${frontmatter}\n${body.trimEnd()}\n`;
    const tmp = this._path(name) + '.tmp';
    await fs.writeFile(tmp, file, 'utf8');
    await fs.rename(tmp, this._path(name));
    return { name, type, decay_class, updated_at: now };
  }

  async get(name) {
    try {
      const raw = await fs.readFile(this._path(name), 'utf8');
      return parseFile(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async list({ type = null } = {}) {
    await this._ensure();
    const entries = await fs.readdir(this.dir);
    const out = [];
    for (const f of entries) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const name = f.slice(0, -3);
      const m = await this.get(name);
      if (!m) continue;
      if (type && m.frontmatter.type !== type) continue;
      out.push(m);
    }
    return out;
  }

  async recall({ requires = [], link_depth = 1, budget_tokens = 2000 } = {}) {
    const seen = new Set();
    const queue = [...requires.map(n => [n, 0])];
    const out = [];

    while (queue.length) {
      const [name, depth] = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const mem = await this.get(name);
      if (!mem) continue;
      out.push(mem);
      if (depth < link_depth) {
        for (const link of mem.body.matchAll(LINK_RE)) queue.push([link[1], depth + 1]);
      }
    }

    // Token budget enforcement (rough char/4 estimate)
    let used = out.reduce((s, m) => s + estimateTokens(m), 0);
    if (used > budget_tokens) {
      out.sort((a, b) => decayRank(a) - decayRank(b)); // drop ephemeral first
      while (out.length > 0 && used > budget_tokens) {
        const dropped = out.pop();
        used -= estimateTokens(dropped);
      }
    }

    return { memories: out, tokens_used: used };
  }

  async dueForReview(asOf = new Date()) {
    const all = await this.list();
    const due = [];
    for (const m of all) {
      const updated = m.frontmatter.updated_at;
      const decay = m.frontmatter.decay_class || 'slow';
      if (!updated) continue;
      const ageDays = (asOf - new Date(updated)) / (1000 * 60 * 60 * 24);
      if (ageDays >= DECAY_DAYS[decay]) due.push({ ...m, age_days: Math.floor(ageDays) });
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
    lines.push(`${k}: ${escapeYamlScalar(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function escapeYamlScalar(v) {
  const s = String(v);
  if (/[:#\n"']/.test(s)) return JSON.stringify(s);
  return s;
}

function parseFile(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw, links: [] };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch {}
    }
    fm[k] = v;
  }
  const body = m[2];
  const links = [...body.matchAll(LINK_RE)].map(x => x[1]);
  return { name: fm.name, frontmatter: fm, body, links };
}

function estimateTokens(mem) {
  return Math.ceil((JSON.stringify(mem.frontmatter).length + mem.body.length) / 4);
}

function decayRank(mem) {
  const order = { permanent: 0, slow: 1, fast: 2, ephemeral: 3 };
  return order[mem.frontmatter.decay_class] ?? 1;
}
