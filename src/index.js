// recall - a tiny memory layer for LLM agents, compatible with Claude Code's auto memory.
//
// Public API:
//   const r = new Recall({ dir, format = 'recall' | 'claude-code' })
//   const r = Recall.forClaudeCode(projectPath)     // the memory Claude Code keeps for that project
//   r.write({ name, type, description, decay_class, body, extra })
//   r.get(name)
//   r.list({ type })
//   r.recall({ requires, link_depth = 1, budget_tokens = 2000 })
//   r.dueForReview(asOf = new Date())
//   r.delete(name)
//   claudeCodeMemoryDir(projectPath)               // where that memory lives on disk

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const DECAY_CLASSES = new Set(['permanent', 'slow', 'fast', 'ephemeral']);
const DECAY_DAYS = { permanent: 365 * 2, slow: 90, fast: 30, ephemeral: 7 };
const FORMATS = new Set(['recall', 'claude-code']);
const RESERVED_KEYS = new Set(['name', 'type', 'description', 'decay_class', 'updated_at', 'metadata', 'modified', 'node_type']);
const DAY_MS = 1000 * 60 * 60 * 24;
const INDEX_FILE = 'MEMORY.md';

// Lowercase ASCII, digits, "-" and "_" (Claude Code names files like feedback_testing.md).
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
const LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

const FRONTMATTER_RE = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/;

const isName = name => typeof name === 'string' && SLUG_RE.test(name);
// "reference-x" and "reference_x" are the same memory as far as links are concerned.
const looseKey = name => name.toLowerCase().replace(/_/g, '-');
const show = v => (typeof v === 'string' ? JSON.stringify(v) : `(${v === null ? 'null' : typeof v})`);

export class Recall {
  constructor({ dir, format = 'recall' } = {}) {
    if (!dir) throw new Error('Recall requires a `dir` option');
    if (!FORMATS.has(format)) throw new Error(`format must be one of ${[...FORMATS].join('|')}; got ${show(format)}`);
    this.dir = dir;
    this.format = format;
  }

  /** The auto memory Claude Code keeps for `projectPath`, read and written in Claude Code's format. */
  static forClaudeCode(projectPath = process.cwd(), options = {}) {
    return new Recall({ dir: claudeCodeMemoryDir(projectPath, options), format: 'claude-code' });
  }

  _path(name) {
    if (!isName(name)) {
      throw new Error(`Invalid name ${show(name)}. Use a-z, 0-9, "-" and "_", starting with a letter or digit, up to 128 chars.`);
    }
    return path.join(this.dir, `${name}.md`);
  }

  async write({ name, type, description = '', decay_class = 'slow', body = '', extra = {} } = {}) {
    this._path(name);
    // Writing "feedback-testing" when feedback_testing.md exists updates that file instead of
    // creating a near-duplicate next to it.
    if (!(await this._read(name))) {
      name = (await this._names()).find(n => looseKey(n) === looseKey(name)) ?? name;
    }
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

    const now = new Date();
    const updated_at = now.toISOString().slice(0, 10);
    let fields;
    if (this.format === 'claude-code') {
      // Keep what Claude Code (or a person) already recorded, e.g. originSessionId.
      const previous = (await this._read(name))?.frontmatter ?? {};
      const kept = {};
      for (const [k, v] of Object.entries({ ...previous, ...(isPlainObject(previous.metadata) ? previous.metadata : {}) })) {
        if (!RESERVED_KEYS.has(k)) kept[k] = v;
      }
      fields = {
        name,
        description,
        metadata: {
          node_type: 'memory',
          type,
          ...kept,
          ...extra,
          ...(decay_class === 'slow' ? {} : { decay_class }),
          modified: now.toISOString(),
        },
      };
    } else {
      fields = { name, type, description, decay_class, updated_at, ...extra };
    }
    await fs.mkdir(this.dir, { recursive: true });
    // Claude Code puts a blank line between the frontmatter and the body; recall's format does not.
    const gap = this.format === 'claude-code' ? '\n' : '';
    await writeAtomic(file, `${stringifyFrontmatter(fields)}\n${gap}${body.trimEnd()}\n`);
    if (this.format === 'claude-code') await this._updateIndex(name, description);
    return { name, type, decay_class, updated_at };
  }

  async get(name) {
    const file = this._path(name);
    const exact = await this._read(name, file);
    if (exact) return exact;
    // A [[link]] may spell the name with "-" where the file uses "_" (or the reverse), or use
    // the frontmatter name instead of the file name.
    const match = await this._resolve(name);
    return match ? this._read(match) : null;
  }

  async list({ type = null } = {}) {
    const out = [];
    for (const name of await this._names()) {
      const m = await this._read(name);
      if (!m) continue;
      if (type && m.type !== type) continue;
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
      if (name !== mem.name) {
        if (seen.has(mem.name)) continue;
        seen.add(mem.name);
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
      if (!m.updated_at) continue;
      const ageDays = (now - new Date(m.updated_at)) / DAY_MS;
      if (Number.isNaN(ageDays)) continue;
      const window = DECAY_DAYS[decayClass(m)] ?? DECAY_DAYS.slow;
      if (ageDays >= window) due.push({ ...m, age_days: Math.floor(ageDays) });
    }
    return due;
  }

  async delete(name) {
    try {
      await fs.unlink(this._path(name));
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    if (this.format === 'claude-code') await this._updateIndex(name, null);
    return true;
  }

  // --- internals ---

  async _read(name, file = this._path(name)) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
      throw e;
    }
    const { frontmatter, body, links } = parseFile(raw, { blankLineAfterFrontmatter: this.format === 'claude-code' });
    const meta = isPlainObject(frontmatter.metadata) ? frontmatter.metadata : {};
    return {
      name,
      type: frontmatter.type ?? meta.type ?? null,
      description: frontmatter.description ?? '',
      updated_at: meta.modified ?? frontmatter.modified ?? frontmatter.updated_at ?? null,
      frontmatter,
      body,
      links,
    };
  }

  // Only <valid-name>.md files are memories. Anything else (the MEMORY.md index, README.md,
  // "My Notes.md", temp files, folders) is ignored.
  async _names() {
    let entries;
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return entries
      .filter(e => !e.isDirectory() && e.name.endsWith('.md') && e.name !== INDEX_FILE)
      .map(e => e.name.slice(0, -3))
      .filter(isName)
      .sort();
  }

  async _resolve(name) {
    const key = looseKey(name);
    const names = await this._names();
    const byFile = names.find(n => looseKey(n) === key);
    if (byFile) return byFile;
    for (const n of names) {
      const fmName = (await this._read(n))?.frontmatter.name;
      if (typeof fmName === 'string' && looseKey(fmName.trim()) === key) return n;
    }
    return null;
  }

  // Claude Code loads MEMORY.md (one line per memory) at the start of every session.
  async _updateIndex(name, description) {
    const file = path.join(this.dir, INDEX_FILE);
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const target = `](${name}.md)`;
    const at = lines.findIndex(l => l.includes(target));
    if (description === null) {
      if (at < 0) return;
      lines.splice(at, 1);
    } else {
      const hook = description.replace(/\s+/g, ' ').trim();
      const line = `- [${name}](${name}.md)${hook ? ` - ${hook}` : ''}`;
      if (at >= 0) lines[at] = line;
      else lines.push(line);
    }
    await writeAtomic(file, lines.length ? `${lines.join('\n')}\n` : '');
  }
}

/**
 * The directory where Claude Code keeps auto memory for `projectPath`, following Claude Code's
 * own rules: the git repository root (the main checkout, for a worktree), turned into a folder
 * name under ~/.claude/projects/. Honors CLAUDE_CONFIG_DIR, CLAUDE_CODE_PROJECT_DIR_NAME and the
 * `autoMemoryDirectory` setting in the project's .claude/settings.local.json or the user settings.
 */
export function claudeCodeMemoryDir(projectPath = process.cwd(), { env = process.env, home = os.homedir() } = {}) {
  // Claude Code names the folder after its working directory, which is the physical path.
  const root = canonicalRoot(realpath(path.resolve(projectPath)));
  const configDir = expandHome(env.CLAUDE_CONFIG_DIR, home) ?? path.join(home, '.claude');
  const custom = autoMemoryDirectorySetting([
    path.join(root, '.claude', 'settings.local.json'),
    path.join(configDir, 'settings.json'),
  ], home);
  if (custom) return custom.normalize('NFC');
  const folder = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CODE_PROJECT_DIR_NAME
    ? env.CLAUDE_CODE_PROJECT_DIR_NAME
    : projectFolderName(root);
  return path.join(configDir, 'projects', folder, 'memory').normalize('NFC');
}

// Claude Code's project folder name: every non-alphanumeric character becomes "-"; names over
// 200 characters are cut and suffixed with a base-36 hash of the full path.
function projectFolderName(p) {
  const slug = p.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

// The nearest enclosing git repository root; for a linked worktree, the main checkout it
// belongs to. Falls back to `p` itself outside git.
function canonicalRoot(p) {
  let root = null;
  for (let dir = p; ; dir = path.dirname(dir)) {
    if (fsSync.existsSync(path.join(dir, '.git'))) { root = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  if (!root) return p;
  try {
    const dotGit = fsSync.readFileSync(path.join(root, '.git'), 'utf8').trim(); // throws for a .git directory
    if (!dotGit.startsWith('gitdir:')) return root;
    const gitDir = path.resolve(root, dotGit.slice(7).trim());
    const commonDir = path.resolve(gitDir, fsSync.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) return root;
    const backLink = fsSync.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
    if (realpath(backLink) !== path.join(realpath(root), '.git')) return root;
    return (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir).normalize('NFC');
  } catch {
    return root;
  }
}

function autoMemoryDirectorySetting(files, home) {
  for (const file of files) {
    let value;
    try {
      value = JSON.parse(fsSync.readFileSync(file, 'utf8'))?.autoMemoryDirectory;
    } catch {
      continue;
    }
    const dir = typeof value === 'string' ? expandHome(value, home) : null;
    if (dir && path.isAbsolute(dir)) return dir.replace(/[/\\]+$/, '');
  }
  return null;
}

function expandHome(p, home) {
  if (!p) return null;
  return p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
}

function realpath(p) {
  try { return fsSync.realpathSync(p); } catch { return path.resolve(p); }
}

// --- helpers ---

// A unique temp file per write, then an atomic rename: concurrent writers never clobber
// each other's temp file, and readers see either the old file or the new one.
async function writeAtomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringifyFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (k === 'metadata' && isPlainObject(v)) {
      lines.push('metadata:');
      for (const [mk, mv] of Object.entries(v)) {
        if (mv != null) lines.push(`  ${mk}: ${stringifyValue(mv)}`);
      }
      continue;
    }
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
  // A ":" not followed by a space (a timestamp, a URL) is fine in a plain YAML scalar.
  if (s === '' || s !== s.trim() || /: |:$|(^|\s)#|[\n\r"']/.test(s) || /^[-?,[\]{}&*!|>%@`]/.test(s)) {
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

// A small YAML subset: `key: value` lines, plus one level of nesting for a key with no value
// followed by indented `key: value` lines (Claude Code's `metadata:` block).
function parseFile(raw, { blankLineAfterFrontmatter = false } = {}) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(FRONTMATTER_RE);
  const frontmatter = {};
  let nested = null;
  for (const line of m?.[1]?.split('\n') ?? []) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    if (!k || k.startsWith('#')) continue;
    const indented = /^\s/.test(line);
    const v = parseValue(line.slice(idx + 1).trim());
    if (indented && nested) {
      frontmatter[nested][k] = v;
      continue;
    }
    nested = null;
    if (v === '' && !indented) {
      frontmatter[k] = {};
      nested = k;
      continue;
    }
    frontmatter[k] = v;
  }
  // A key with no value and nothing indented under it is an empty string, not an empty map.
  for (const [k, v] of Object.entries(frontmatter)) {
    if (isPlainObject(v) && Object.keys(v).length === 0) frontmatter[k] = '';
  }
  // Claude Code leaves a blank line after the frontmatter; in its format that is layout, not content.
  const body = (m ? (blankLineAfterFrontmatter ? m[2].replace(/^\n+/, '') : m[2]) : text).trimEnd();
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

function decayClass(mem) {
  const meta = isPlainObject(mem.frontmatter.metadata) ? mem.frontmatter.metadata : {};
  return mem.frontmatter.decay_class ?? meta.decay_class ?? 'slow';
}

function decayRank(mem) {
  const order = { permanent: 0, slow: 1, fast: 2, ephemeral: 3 };
  return order[decayClass(mem)] ?? 1;
}
