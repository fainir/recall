// A minimal example of using recall to back an agent's memory.
// Run: node examples/basic.js

import { Recall } from '../src/index.js';

const r = new Recall({ dir: './example-memory' });

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

const slice = await r.recall({
  requires: ['voice', 'top-customers'],
  link_depth: 1,
  budget_tokens: 1500,
});

console.log('Tokens used:', slice.tokens_used);
for (const m of slice.memories) {
  console.log('---');
  console.log(`# ${m.name}  (${m.frontmatter.type}, ${m.frontmatter.decay_class})`);
  console.log(m.body.trim());
}

const due = await r.dueForReview();
console.log('\nDue for review:', due.map(d => `${d.name} (${d.age_days}d)`));
