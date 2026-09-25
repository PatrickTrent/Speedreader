import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('built client bundle does not contain the Gemini key or API host', () => {
  assert.ok(
    fs.existsSync(path.join(distDir, 'index.html')),
    'dist/index.html is missing. Run npm run build before npm test.',
  );
  const hits = [];
  for (const file of walk(distDir)) {
    const text = fs.readFileSync(file).toString('latin1');
    if (text.includes('GEMINI_API_KEY')) hits.push(`${file} contains GEMINI_API_KEY`);
    if (text.includes('generativelanguage')) hits.push(`${file} contains generativelanguage`);
  }
  assert.deepEqual(hits, []);
});
