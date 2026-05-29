# recall

A tiny memory layer for LLM agents. Markdown files, kebab-case slugs, `[[wiki-links]]`, and a recall API that picks the right slice for the job.

Open-sourced by the team at [Cosfounder](https://cosfounder.com).

## Why

Long contexts solve the wrong problem. The right problem is: *what does this agent need to know, right now, to do this specific job well?*

`recall` is the tiny library that lets you:

1. **Write** memories as markdown files with frontmatter.
2. **Link** them with `[[name]]` wiki-style references.
3. **Tag** them by `type` (user / feedback / project / reference) and `decay_class` (permanent / slow / fast / ephemeral).
4. **Recall** the right slice at inference time, in under a millisecond.

It's the memory pattern we run at Cosfounder for our AI Chief of Staff. After 6 months of production use across 50+ founders, the design has held up. We're shipping the core as a standalone library so you can use it for any agent that interacts with the same human repeatedly.

## Install

```bash
npm install @cosfounder/recall
```

## Quick start

```js
import { Recall } from '@cosfounder/recall';

const r = new Recall({ dir: './memory' });

// Write
await r.write({
  name: 'voice',
  type: 'user',
  description: "the founder's email + Slack voice",
  body: 'Terse. Uses dashes. Signs "-N". Lowercase when casual.',
});

// Read by name
const voice = await r.get('voice');

// Recall for a job: returns only the memories the agent asked for.
const slice = await r.recall({
  requires: ['voice', 'top-customers'],
  budget_tokens: 1500,
});
// → { memories: [{ name, body, frontmatter }, ...], tokens_used: 412 }

// Decay tick: surface memories due for review
const due = await r.dueForReview();
```

## Memory file format

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

The `[[acmecorp-parent]]` link is parsed at read time and surfaced as a reference so the agent can walk to it on demand.

## Recall strategy

`recall()` returns the smallest set of memories that satisfies:

1. Every name in `requires` (exact-match recall, never embedding-based).
2. Every name reachable via `[[wiki-link]]` from a required memory, up to depth `link_depth` (default 1).
3. Token budget enforced post-walk; if over, drop ephemeral first, then fast, then slow.

The library deliberately does NOT do semantic search across memory content. For an operator agent, you know the keys; you don't want fuzzy retrieval.

## Decay

The `decay_class` field is metadata for the agent that runs reviews:

- `permanent` - never auto-decays. Review every 6 months.
- `slow` - review every 90 days.
- `fast` - review every 30 days.
- `ephemeral` - auto-expire 7 days after `updated_at`.

`recall.dueForReview()` returns memories where the review window has elapsed. Your agent presents them to the user and writes back the confirmed/edited version.

## Why not vector embeddings?

Tried it. For operator-style agents:

- Recall is *unfocused* - asking for "voice" returns four memories that *mention* voice.
- Memory pollution - one wrong write contaminates retrieval for weeks.
- No way to enforce a token budget without reranking.

Explicit-key recall is simpler, faster, and the agent's required-keys list doubles as documentation.

## Limits

- Single-tenant: you bring your own per-user directory.
- No multi-process write lock yet (file rename is atomic enough for our use; PRs welcome).
- No built-in encryption: stash the directory inside an encrypted volume if your data is sensitive.

## License

MIT.

## See also

- [Cosfounder](https://cosfounder.com) - the AI Chief of Staff for founders, built on recall.
- The original blog post on the memory architecture: [How we built memory for an AI operator](https://cosfounder.com/blog/memory-architecture)
