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

function priceValue(value) {
  return value === 0.99 || value === 3.99 || value === '0.99' || value === '3.99';
}

/** Structured JSON-LD Offer: EUR price, VAT flagged, so the euro phrase is optional. */
export function isQualifiedVatOffer(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (!types.includes('Offer')) return false;
  const spec = node.priceSpecification;
  const currency = node.priceCurrency || spec?.priceCurrency;
  const price = node.price ?? spec?.price;
  if (currency !== 'EUR' || !priceValue(price)) return false;
  if (!spec || spec.valueAddedTaxIncluded !== true) return false;
  return true;
}

function assertJsonNode(node, file, exempt) {
  if (typeof node === 'string') {
    if (!exempt) assertFollowed(node, file);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) assertJsonNode(item, file, exempt);
    return;
  }
  if (node && typeof node === 'object') {
    const next = exempt || isQualifiedVatOffer(node);
    for (const value of Object.values(node)) assertJsonNode(value, file, next);
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
    assertJsonNode(data, `${file} JSON-LD`, false);
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

test('a JSON-LD Offer with EUR price and valueAddedTaxIncluded may omit the prose suffix', () => {
  const offer = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Offer",
      "priceCurrency": "EUR",
      "price": "0.99",
      "priceSpecification": {
        "@type": "PriceSpecification",
        "priceCurrency": "EUR",
        "price": "0.99",
        "valueAddedTaxIncluded": true
      },
      "description": "Starter €0,99"
    }
    </script>
  `;
  assertPricesIncludeVat(offer, 'offer-fixture');

  const faq = `
    <script type="application/ld+json">
    { "@type": "FAQPage", "mainEntity": [{ "@type": "Answer", "text": "Starter €0,99/5" }] }
    </script>
  `;
  assert.throws(() => assertPricesIncludeVat(faq, 'faq-fixture'), /incl\. btw or incl\. VAT/);

  const bare = '<p>€3,99</p>';
  assert.throws(() => assertPricesIncludeVat(bare, 'bare-fixture'), /incl\. btw or incl\. VAT/);
  assertPricesIncludeVat('<p>€3,99 incl. VAT</p><p>€0,99 incl. btw</p>', 'ok-fixture');
});
