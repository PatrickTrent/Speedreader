import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PRICE = /€(?:0,99|3,99)/g;
const FOLLOWED = /^(?:[ \t\n\r]|\u00a0)*(?:\(\s*)?incl\. (?:btw|VAT)\b/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

function euroHits(text) {
  return [...text.matchAll(PRICE)];
}

function assertFollowed(text, file) {
  for (const hit of euroHits(text)) {
    const after = text.slice(hit.index + hit[0].length, hit.index + hit[0].length + 32);
    assert.match(
      after,
      FOLLOWED,
      `${file}: ${hit[0]} must be followed by incl. btw or incl. VAT, saw ${JSON.stringify(after)}`,
    );
  }
}

function assertJsonNode(node, file) {
  if (typeof node === 'string') {
    assertFollowed(node, file);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) assertJsonNode(item, file);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) assertJsonNode(value, file);
  }
}

export function assertPricesIncludeVat(source, file) {
  const jsonBlocks = [];
  const prose = source.replace(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi, (_full, body) => {
    jsonBlocks.push(body);
    return '';
  });
  assertFollowed(prose, file);
  for (const body of jsonBlocks) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      assertFollowed(body, `${file} JSON-LD`);
      continue;
    }
    assertJsonNode(data, `${file} JSON-LD`);
  }
}

function walkSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (entry.name.endsWith('.html') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('every €0,99 and €3,99 in HTML and TSX is followed by incl. btw or incl. VAT', () => {
  const files = walkSources(path.resolve('.'));
  assert.ok(files.some((file) => file.endsWith(`${path.sep}App.tsx`)));
  assert.ok(files.some((file) => file.endsWith(`${path.sep}index.html`)));
  for (const file of files) {
    assertPricesIncludeVat(fs.readFileSync(file, 'utf8'), path.relative(path.resolve('.'), file));
  }
});

test('FAQPage JSON-LD prices need incl. btw or incl. VAT', () => {
  const faq = `
    <script type="application/ld+json">
    { "@type": "FAQPage", "mainEntity": [{ "@type": "Answer", "text": "Starter €0,99/5" }] }
    </script>
  `;
  assert.throws(() => assertPricesIncludeVat(faq, 'faq-fixture'), /incl\. btw or incl\. VAT/);
  assertPricesIncludeVat(`
    <script type="application/ld+json">
    { "@type": "FAQPage", "mainEntity": [{ "@type": "Answer", "text": "Starter €0,99 incl. btw/5" }] }
    </script>
  `, 'faq-ok');

  const bare = '<p>€3,99</p>';
  assert.throws(() => assertPricesIncludeVat(bare, 'bare-fixture'), /incl\. btw or incl\. VAT/);
  assertPricesIncludeVat('<p>€3,99 incl. VAT</p><p>€0,99 incl. btw</p>', 'ok-fixture');
});
