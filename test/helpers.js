import { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Recall } from '../src/index.js';

const dirs = [];

after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

// A fresh, empty memory directory per test so tests never share state.
export async function fresh() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-test-'));
  dirs.push(dir);
  return { dir, r: new Recall({ dir }) };
}

// A path inside a temp dir that does not exist yet.
export async function missingDir() {
  const { dir } = await fresh();
  return path.join(dir, 'not', 'there', 'yet');
}

export async function writeRaw(dir, file, content) {
  await fs.writeFile(path.join(dir, file), content, 'utf8');
}
