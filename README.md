# recall

[![CI](https://github.com/fainir/recall/actions/workflows/ci.yml/badge.svg)](https://github.com/fainir/recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tiny memory layer for LLM agents that work with the same person again and again: Markdown files, `[[wiki-links]]`, and a `recall()` call that returns exactly the memories a job asks for, within a token budget. No vectors, no database, no dependencies.

Long contexts solve the wrong problem. The right question is: *what does this agent need to know, right now, to do this specific job well?* With `recall`, each job names the memories it needs, the library follows their links, trims the result to fit your token budget and hands back a slice you put in the prompt. The memories are plain files you can read, diff and edit by hand.

## Install

Not published to npm yet. Install it from GitHub (Node 18+, ES modules):

```bash
npm install github:fainir/recall
```

```js
import { Recall } from '@cosfounder/recall';
```

## Quick start

```js
import { Recall } from '@cosfounder/recall';

// One directory per user. It is created on the first write.
const r = new Recall({ dir: './memory' });

await r.write({
  name: 'voice',
  type: 'user',
  description: "the founder's email + Slack voice",
  decay_class: 'permanent',
  body: 'Terse. Uses dashes. Signs "-N". House rules: [[style-guide]].',
});
await r.write({
  name: 'style-guide',
  type: 'reference',
  body: 'No exclamation marks. Never "circle back".',
});

// A job names the memories it needs; [[links]] are followed one hop by default.
const slice = await r.recall({ requires: ['voice', 'top-customers'], budget_tokens: 1500 });

console.log(slice.memories.map(m => m.name));
console.log(slice.missing, slice.dropped, slice.tokens_used);

// Hand the slice to the model, e.g. in the system prompt.
const context = slice.memories.map(m => `## ${m.name}\n${m.body}`).join('\n\n');
console.log(context);
```

Output:

```text
[ 'voice', 'style-guide' ]
[ 'top-customers' ] [] 86
## voice
Terse. Uses dashes. Signs "-N". House rules: [[style-guide]].

## style-guide
No exclamation marks. Never "circle back".
```

`top-customers` was never written, so it is reported in `missing` instead of throwing. Your agent can ask the user for it, or write it.

## API

The package exports one class, `Recall`. Every method except the constructor is async.

| Call | Arguments | Returns |
|------|-----------|---------|
| `new Recall({ dir })` | `dir`: directory for one user's memories | a `Recall` instance |
| `write({ name, type, description, decay_class, body, extra })` | `name`: kebab-case slug (required). `type`: `user` \| `feedback` \| `project` \| `reference` (required). `description`: string, default `''`. `decay_class`: `permanent` \| `slow` \| `fast` \| `ephemeral`, default `slow`. `body`: Markdown string, default `''`. `extra`: object of additional frontmatter fields | `{ name, type, decay_class, updated_at }`. Creates or overwrites `<dir>/<name>.md` and sets `updated_at` to today (UTC) |
| `get(name)` | a memory name | a `Memory`, or `null` if it does not exist |
| `list({ type })` | optional `type` filter | `Memory[]`, sorted by name |
| `recall({ requires, link_depth, budget_tokens })` | `requires`: array of names. `link_depth`: how many `[[link]]` hops to follow, default `1`. `budget_tokens`: default `2000` | `{ memories: Memory[], tokens_used, missing: string[], dropped: string[] }` |
| `dueForReview(asOf)` | `Date` or date string, default now | `Memory[]` whose review window has passed, each with `age_days` |
| `delete(name)` | a memory name | `true` if a file was removed, `false` if it did not exist |

A `Memory` is `{ name, frontmatter, body, links }`, where `links` is the list of memory names the body links to (deduplicated, in order).

`write`, `get` and `delete` throw on an invalid name; `write` also throws on an invalid `type` or `decay_class`, a non-string `body` or `description`, or an `extra` key that is reserved or not a plain identifier. `recall` never throws on unknown or invalid names; it puts them in `missing`.

## Memory file format

Each memory is one file, `<name>.md`, with frontmatter and a Markdown body:

```markdown
---
name: top-customers
type: project
description: paying customers above $10K ACV
decay_class: slow      # permanent | slow | fast | ephemeral
updated_at: 2026-05-25
---

- Northwind - $48K ACV, primary CSM is Maya
- AcmeCorp - $18K ACV across 6 child accounts (see [[acmecorp-parent]])
- Globex - $4K ACV, SMB
```

- **Names** are kebab-case: `a-z`, `0-9` and `-`, starting with a letter or digit, up to 64 characters. This keeps file names safe on every OS (no paths, no unicode normalization or case-folding surprises).
- **Links**: `[[name]]`, `[[name|label]]` and `[[name#heading]]` all point at `name`. Links are case-insensitive, and links inside fenced code blocks or inline code are ignored. They are parsed at read time and returned in `links`, so the agent can walk to them on demand.
- **Frontmatter** is a small YAML subset: one `key: value` per line, `"double"` or `'single'` quoted strings and `# comments`. Values come back as strings, except arrays and objects passed in `extra`, which are stored as JSON and come back as arrays and objects.
- Other files in the directory (`README.md`, a `MEMORY.md` index, `My Notes.md`, folders) are ignored by `list()` and `dueForReview()`.

## How `recall()` picks the slice

1. Every name in `requires`, by exact match. No embeddings, no fuzzy matching.
2. Every memory reachable via `[[wiki-links]]` from those, breadth-first, up to `link_depth` hops.
3. If the total is over `budget_tokens` (estimated as characters / 4), memories are dropped until it fits: the deepest links first, so the required memories go last; at the same depth, `ephemeral` first, then `fast`, `slow`, `permanent`. Their names are returned in `dropped`, and the rest keep their walk order.

The library deliberately does NOT do semantic search across memory content. For an operator agent, you know the keys; you don't want fuzzy retrieval.

## Decay

`decay_class` tells the agent that runs reviews how often a memory should be re-confirmed:

| `decay_class` | Due for review after |
|---------------|----------------------|
| `permanent` | 730 days |
| `slow` (default) | 90 days |
| `fast` | 30 days |
| `ephemeral` | 7 days |

`r.dueForReview()` returns the memories whose `updated_at` is older than their window (an unknown `decay_class` counts as `slow`). Nothing is deleted or hidden automatically: your agent presents them to the user and writes back the confirmed or edited version, which resets `updated_at`.

## Example

[`examples/basic.js`](examples/basic.js) writes three memories, recalls a slice for a job and checks what is due for review. Run it from a clone with `node examples/basic.js`:

```text
Tokens used: 141
Missing: [ 'pricing' ]
Dropped: []

## voice (user, permanent)
Terse, founder-to-founder. Uses dashes. Signs "-N".

## top-customers (project, slow)
- Northwind - $48K ACV, see [[northwind-account]]
- AcmeCorp - $18K ACV
- Globex - $4K ACV

## northwind-account (project, slow)
CSM: Maya Chen. Renewal: 2026-Q3. Watch for: parent account child-account refund pattern.

Due for review in 100 days: [ 'northwind-account (100d)', 'top-customers (100d)' ]
```

## Why not vector embeddings?

Tried it. For operator-style agents:

- Recall is *unfocused* - asking for "voice" returns four memories that *mention* voice.
- Memory pollution - one wrong write contaminates retrieval for weeks.
- No way to enforce a token budget without reranking.

Explicit-key recall is simpler, faster, and the agent's required-keys list doubles as documentation.

## Limitations

- Single-tenant: you bring your own per-user directory.
- Writes are atomic (temp file + rename), so readers never see a half-written file and concurrent writes to the same memory never corrupt it, but the last writer wins. There is no lock or merge across processes.
- The token count is a rough estimate (characters / 4), not a real tokenizer. Leave some headroom.
- `list()` and `dueForReview()` read every file in the directory; there is no index.
- No built-in encryption: keep the directory on an encrypted volume if your data is sensitive.

## Development

No dependencies, so there is nothing to install:

```bash
git clone https://github.com/fainir/recall.git
cd recall
npm test                 # node:test, no network
node examples/basic.js
```

## License

[MIT](LICENSE)
