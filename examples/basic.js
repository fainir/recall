// A minimal example of using recall to back an agent's memory.
// Run: node examples/basic.js  (writes to ./example-memory, which is git-ignored)

import { fileURLToPath } from 'node:url';
import { Recall } from '../src/index.js';

const r = new Recall({ dir: fileURLToPath(new URL('../example-memory', import.meta.url)) });

await r.write({
  name: 'voice',
  type: 'user',
  description: "the user's voice",
  decay_class: 'permanent',
  body: 'Terse, founder-to-founder. Uses dashes. Signs "-N".',
});

await r.write({
  name: 'top-customers',
  type: 'project',
  decay_class: 'slow',
  body: `
- Northwind - $48K ACV, see [[northwind-account]]
- AcmeCorp - $18K ACV
- Globex - $4K ACV
`,
});

await r.write({
  name: 'northwind-account',
  type: 'project',
  decay_class: 'slow',
  body: 'CSM: Maya Chen. Renewal: 2026-Q3. Watch for: parent account child-account refund pattern.',
});

// The job "draft a renewal email" declares the memories it needs.
// `pricing` was never written, so it comes back in `missing` instead of throwing.
const slice = await r.recall({
  requires: ['voice', 'top-customers', 'pricing'],
  link_depth: 1,
  budget_tokens: 1500,
});

console.log('Tokens used:', slice.tokens_used);
console.log('Missing:', slice.missing);
console.log('Dropped:', slice.dropped);

// What goes into the agent's prompt:
const context = slice.memories
  .map(m => `## ${m.name} (${m.frontmatter.type}, ${m.frontmatter.decay_class})\n${m.body.trim()}`)
  .join('\n\n');
console.log(`\n${context}\n`);

// Pretend 100 days have passed: slow memories (90-day window) are due, permanent ones are not.
const later = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
const due = await r.dueForReview(later);
console.log('Due for review in 100 days:', due.map(d => `${d.name} (${d.age_days}d)`));
