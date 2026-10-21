import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('vite build omits a unique Gemini key value', () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'speedreader-dist-'));
  const fake = `gemini-test-key-${randomBytes(16).toString('hex')}`;
  const viteBin = path.resolve('node_modules/vite/bin/vite.js');
  const result = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir], {
    cwd: process.cwd(),
    env: { ...process.env, GEMINI_API_KEY: fake },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const hits = [];
    for (const file of walk(outDir)) {
      const text = fs.readFileSync(file).toString('latin1');
      if (text.includes(fake)) hits.push(`${file} contains the build-time key`);
      if (text.includes('GEMINI_API_KEY')) hits.push(`${file} contains GEMINI_API_KEY`);
      if (text.includes('generativelanguage')) hits.push(`${file} contains generativelanguage`);
      if (text.includes('91688621')) hits.push(`${file} contains the old KvK number`);
    }
    assert.deepEqual(hits, []);
    const pages = ['privacy/index.html', 'rsvp/index.html', 'ai-summary/index.html', 'for-builders/index.html', 'read-long-pdf/index.html'];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(outDir, page), 'utf8');
      assert.ok(html.includes('91686210'), page);
      assert.ok(html.includes('Trentelman AI Solutions, KvK 91686210, btw NL004908763B50, Groningen'), page);
    }
    const bundled = walk(outDir).filter((file) => file.endsWith('.js')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.ok(bundled.includes('91686210'));
    assert.equal(bundled.includes('91688621'), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
