# recall

[![CI](https://github.com/fainir/recall/actions/workflows/ci.yml/badge.svg)](https://github.com/fainir/recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your Claude Code memory, in every agent.** recall reads and writes the memory Claude Code keeps for each project, so Codex, Cursor or an agent you build yourself can use the same memories, over MCP or from code. Zero dependencies, no vectors, no database: the memories stay plain Markdown files.

Claude Code now remembers things on its own: your corrections, how you like to work, project decisions, where things live. It saves them as Markdown files with `[[wiki-links]]` under `~/.claude/projects/<project>/memory/`. That is a good format, but only Claude Code reads it. Switch to another agent and it starts from zero.

recall makes that memory portable. It finds the same directory Claude Code uses (same rules, down to its folder-naming hash), reads every file Claude Code writes, and writes files Claude Code reads back.

## Quick start: share it over MCP

Point any MCP client at recall and the project's repository. `--read-only` lets the other agent read what Claude Code remembers without changing it; leave it off to let both write.

**Codex**

```bash
codex mcp add recall -- npx -y github:fainir/recall --claude-code /path/to/your/repo --read-only
```

**Cursor** (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "recall": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:fainir/recall", "--claude-code", "/path/to/your/repo", "--read-only"]
    }
  }
}
```

**Any other MCP client**: run `npx -y github:fainir/recall` with the same arguments as a stdio server. Needs Node.js 18+. The package is not on npm yet, so `npx` installs it from GitHub.

The agent then has these tools. Here is a real run against a repository with three memories Claude Code wrote:

```text
> memory_list
3 memories in /Users/you/.claude/projects/-Users-you-code-acme-api/memory:
- feedback_testing (feedback) - run the integration suite before saying a change works
- reference_ci (reference) - where CI runs and how to rerun a flaky job
- user_role (user) - backend lead, prefers short answers with the command to run

> memory_recall {"requires": ["feedback_testing"]}
## feedback_testing (feedback) - run the integration suite before saying a change works
Run `npm run test:int` (needs the local Postgres from docker compose), not just `npm test`.
**Why:** the unit tests mock the database; two "done" changes broke prod queries.
**How to apply:** any change under src/db/ or src/queries/. CI details in [[reference_ci]].

## reference_ci (reference) - where CI runs and how to rerun a flaky job
CI is GitHub Actions, workflow `ci.yml`. Rerun a flaky job with `gh run rerun --failed`.

tokens_used: 180
```

`memory_recall` followed the `[[reference_ci]]` link on its own. In testing, a Codex agent given only this server answered a question by calling `memory_list` and then `memory_get`.

| Tool | What it does |
|------|--------------|
| `memory_list` | Every memory with its type and one-line description. Optional `type` filter. |
| `memory_get` | One memory in full. `feedback-testing` and `feedback_testing` both work. |
| `memory_recall` | The named memories plus the ones they `[[link]]` to, trimmed to a token budget. Unknown names come back as `missing`. |
| `memory_due` | Memories old enough to re-confirm before relying on them. |
| `memory_write` | Save or replace a memory in Claude Code's format, and add it to the `MEMORY.md` index. Not offered with `--read-only`. |
| `memory_delete` | Delete a memory and its index line. Not offered with `--read-only`. |

`recall-mcp` options: `--claude-code [repo]` (the default, using the current directory), `--dir <dir>` for any other memory directory (add `--format claude-code` to write Claude Code's file format there), and `--read-only`. `RECALL_DIR` and `RECALL_READ_ONLY=1` work as environment variables.

## Use it from code

```bash
npm install github:fainir/recall
```

```js
import { Recall } from '@cosfounder/recall';

const memory = Recall.forClaudeCode('/Users/you/code/acme-api');
console.log(memory.dir);

for (const m of await memory.list()) console.log(m.name, '|', m.type, '|', m.description);

const slice = await memory.recall({ requires: ['feedback-testing'] });
console.log(slice.memories.map(m => m.name), slice.tokens_used);

// Save something Claude Code will see in its next session.
await memory.write({
  name: 'project_freeze',
  type: 'project',
  description: 'merge freeze until the 3rd for the mobile release',
  body: 'No merges to main until Nov 3. **Why:** mobile release cut.',
});
```

Output (before the write):

```text
/Users/you/.claude/projects/-Users-you-code-acme-api/memory
feedback_testing | feedback | run the integration suite before saying a change works
reference_ci | reference | where CI runs and how to rerun a flaky job
user_role | user | backend lead, prefers short answers with the command to run
[ 'feedback_testing', 'reference_ci' ] 180
```

`write()` produces the file Claude Code itself writes:

```markdown
---
name: project_freeze
description: merge freeze until the 3rd for the mobile release
metadata:
  node_type: memory
  type: project
  modified: 2026-10-27T17:51:14.486Z
---

No merges to main until Nov 3. **Why:** mobile release cut.
```

and adds a line to `MEMORY.md`, the index Claude Code loads at the start of every session, leaving the existing lines alone:

```markdown
- [Testing](feedback_testing.md) - run the integration suite before saying a change works
- [CI](reference_ci.md) - where CI runs and how to rerun a flaky job
- [Role](user_role.md) - backend lead, prefers short answers
- [project_freeze](project_freeze.md) - merge freeze until the 3rd for the mobile release
```

Rewriting an existing memory keeps the fields recall does not own, such as Claude Code's `originSessionId`.

## Where Claude Code keeps the memory

`claudeCodeMemoryDir(repo)` returns the directory, using Claude Code's rules:

- The project is the **git repository root**, so subfolders share one memory, and a **worktree** uses the memory of its main checkout. Outside git, it is the folder itself.
- The folder name is the project path with every character other than `a-z`, `A-Z` and `0-9` turned into `-`. Paths longer than 200 characters are cut and given the same hash suffix Claude Code adds.
- `CLAUDE_CONFIG_DIR` replaces `~/.claude`. `CLAUDE_CODE_PROJECT_DIR_NAME` (next to `CLAUDE_CONFIG_DIR`) names the folder. An `autoMemoryDirectory` setting in the project's `.claude/settings.local.json` or your `~/.claude/settings.json` wins over both.

This was checked against a real `~/.claude/projects` folder: the rule reproduced 40 of 41 project folder names, including all three long, hashed ones (the other one belonged to a session that was moved after it started). recall listed and parsed all 194 memory files in it.

## API

The package exports the `Recall` class and `claudeCodeMemoryDir()`. Every method is async.

| Call | Arguments | Returns |
|------|-----------|---------|
| `Recall.forClaudeCode(repo)` | path inside a project; default the current directory | a `Recall` on Claude Code's memory directory, in `claude-code` format |
| `new Recall({ dir, format })` | `dir`: memory directory. `format`: `recall` (default) or `claude-code` | a `Recall` instance |
| `write({ name, type, description, decay_class, body, extra })` | `name`: slug (required). `type`: `user` \| `feedback` \| `project` \| `reference` (required). `description`: one line, default `''`. `decay_class`: `permanent` \| `slow` \| `fast` \| `ephemeral`, default `slow`. `body`: Markdown, default `''`. `extra`: more frontmatter fields | `{ name, type, decay_class, updated_at }`. Creates or replaces `<dir>/<name>.md`; in `claude-code` format also updates `MEMORY.md` |
| `get(name)` | a memory name; `-` and `_` are interchangeable, and a frontmatter `name` also matches | a `Memory`, or `null` |
| `list({ type })` | optional `type` filter | `Memory[]`, sorted by name |
| `recall({ requires, link_depth, budget_tokens })` | `requires`: names. `link_depth`: `[[link]]` hops to follow, default `1`. `budget_tokens`: default `2000` | `{ memories: Memory[], tokens_used, missing: string[], dropped: string[] }` |
| `dueForReview(asOf)` | `Date` or date string, default now | `Memory[]` past their review window, each with `age_days` |
| `delete(name)` | exact memory name | `true` if a file was removed, `false` if it did not exist |
| `claudeCodeMemoryDir(repo)` | path inside a project | the directory path (it may not exist yet) |

A `Memory` is `{ name, type, description, updated_at, frontmatter, body, links }`. `type` and `updated_at` come from the flat fields or from Claude Code's `metadata:` block, whichever the file has. `links` lists the memory names the body links to, deduplicated and in order.

`write`, `get` and `delete` throw on an unsafe name; `write` also throws on an invalid `type` or `decay_class`, a non-string `body` or `description`, or a reserved `extra` key. `recall` never throws on unknown names; it lists them in `missing`.

## Memory file format

One file per memory, `<name>.md`, with frontmatter and a Markdown body. recall reads both shapes, whichever `format` you pick for writing.

Claude Code's format (`format: 'claude-code'`; older Claude Code files have a flat `type:` instead of `metadata:`, and recall reads those too):

```markdown
---
name: feedback_testing
description: run the integration suite before saying a change works
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-20T09:12:44.120Z
---

Run `npm run test:int` first. CI details in [[reference_ci]].
```

recall's own format (`format: 'recall'`, the default, which earlier versions wrote):

```markdown
---
name: top-customers
type: project
description: paying customers above $10K ACV
decay_class: slow
updated_at: 2026-05-25
---
- Northwind - $48K ACV (see [[northwind-account]])
```

- **Names**: `a-z`, `0-9`, `-` and `_`, starting with a letter or digit, up to 128 characters. That keeps file names safe on every OS.
- **Links**: `[[name]]`, `[[name|label]]` and `[[name#heading]]` all point at `name`. They are case-insensitive, `-` and `_` match each other, and links inside code are ignored.
- **Frontmatter** is a small YAML subset: `key: value` lines, quoted strings, `# comments`, and one level of nesting (Claude Code's `metadata:` block).
- Other files (`MEMORY.md`, `README.md`, `My Notes.md`, folders) are not memories and are skipped.

## How `recall()` picks the slice

1. Every name in `requires`. No embeddings, no fuzzy search.
2. Every memory reachable through `[[wiki-links]]` from those, breadth-first, up to `link_depth` hops.
3. If the total is over `budget_tokens` (estimated as characters / 4), memories are dropped until it fits: the deepest links first, so the required memories go last; at the same depth, `ephemeral` first, then `fast`, `slow`, `permanent`. Their names come back in `dropped`, and the rest keep their walk order.

For an agent that knows what it needs, explicit keys beat similarity search: asking for "voice" should return the voice memory, not four memories that mention the word.

## Decay

`decay_class` says how often a memory should be re-confirmed. `dueForReview()` returns the ones whose last update (Claude Code's `modified`, or recall's `updated_at`) is older than their window. Nothing is deleted automatically.

| `decay_class` | Due for review after |
|---------------|----------------------|
| `permanent` | 730 days |
| `slow` (default) | 90 days |
| `fast` | 30 days |
| `ephemeral` | 7 days |

## Limitations

- **Privacy:** serving Claude Code's memory to another agent sends those memories to that agent's model provider. Use `--read-only` and point it only at projects you are happy to share.
- Claude Code reads `MEMORY.md` at the start of a session, so a memory another agent writes shows up in Claude Code's next session, not the current one. Claude Code loads only the first 200 lines (or 25 KB) of that index.
- Writes are atomic (temp file + rename), but the last writer wins. There is no locking between recall and a running Claude Code session.
- Auto memory is per machine. recall does not sync it anywhere.
- The token count is an estimate (characters / 4), not a tokenizer.

## Development

No dependencies, so there is nothing to install:

```bash
git clone https://github.com/fainir/recall.git
cd recall
npm test                 # node:test, no network
node examples/basic.js   # the library on a plain recall directory
```

## License

[MIT](LICENSE)
