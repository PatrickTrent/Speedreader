import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOW_BALANCE_BUTTON,
  LOW_BALANCE_OFFER,
  PRO_PURCHASE_LINE,
  STARTER_PURCHASE_LINE,
  quietCreditLine,
  summaryOfferKind,
} from '../lib/summary-offer.js';

test('pack lines above the buy buttons say the price includes btw', () => {
  assert.equal(
    STARTER_PURCHASE_LINE,
    '5 credits voor €0,99 incl. btw: 5 AI-samenvattingen. Eenmalig, geen abonnement. Betaal met iDEAL of kaart.',
  );
  assert.equal(
    PRO_PURCHASE_LINE,
    '50 credits voor €3,99 incl. btw: 50 AI-samenvattingen. Eenmalig, geen abonnement. Betaal met iDEAL of kaart.',
  );
  assert.equal(LOW_BALANCE_OFFER, 'Nog 5 samenvattingen voor €0,99 (incl. btw, eenmalig, iDEAL of kaart)');
  assert.equal(LOW_BALANCE_BUTTON, 'Koop 5 credits');
  for (const line of [STARTER_PURCHASE_LINE, PRO_PURCHASE_LINE, LOW_BALANCE_OFFER, LOW_BALANCE_BUTTON]) {
    const lower = line.toLowerCase();
    assert.equal(lower.includes('laatste kans'), false, line);
    assert.equal(lower.includes('alleen vandaag'), false, line);
    assert.equal(lower.includes('haast'), false, line);
    assert.equal(lower.includes('mis dit'), false, line);
  }
});

test('a low balance offers the small pack and a higher balance only names the credits', () => {
  assert.equal(summaryOfferKind(0), 'low');
  assert.equal(summaryOfferKind(1), 'low');
  assert.equal(summaryOfferKind(2), 'quiet');
  assert.equal(summaryOfferKind(50), 'quiet');
  assert.equal(summaryOfferKind(null), 'none');
  assert.equal(summaryOfferKind(undefined), 'none');
  assert.equal(summaryOfferKind(Number.NaN), 'none');
  assert.equal(quietCreditLine(2), 'Nog 2 credits.');
  assert.equal(quietCreditLine(12), 'Nog 12 credits.');
  assert.equal(quietCreditLine(1), 'Nog 1 credit.');
  assert.equal(quietCreditLine(4).includes('€'), false);
  assert.equal(quietCreditLine(4).includes('Koop'), false);
});

test('the summary result shows the text, then the offer, and keeps event counting', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  const start = app.indexOf('id="summary-result"');
  const end = app.indexOf('<FaqAccordion />', start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const block = app.slice(start, end);
  assert.ok(block.includes('{summaryResult}'));
  assert.ok(block.indexOf('{summaryResult}') < block.indexOf('{LOW_BALANCE_OFFER}'));
  assert.ok(block.includes("handleStripePurchase('SMALL')"));
  assert.equal(block.includes("handleStripePurchase('LARGE')"), false);
  assert.ok(block.includes('{LOW_BALANCE_BUTTON}'));
  assert.ok(block.includes('quietCreditLine(credits)'));
  assert.equal(block.includes('fixed'), false);
  assert.equal(block.includes('absolute'), false);
  assert.equal(block.includes('reportEvent'), false);
  assert.equal(block.includes('animate-pulse'), false);

  assert.match(app, /setSummaryResult\(summary\)/);
  assert.match(app, /setSummaryResult\(null\)/);
  assert.match(app, /navigator\.sendBeacon\('\/api\/event', body\)/);
  assert.match(app, /reportEvent\('reader_started'\)/);
  assert.match(app, /reportEvent\('summary_purchased'\)/);
  const claim = app.slice(app.indexOf("params.get('session_id')"), app.indexOf('const pack = packFromBuy'));
  assert.match(claim, /reportEvent\('summary_purchased'\)/);
  assert.equal(claim.includes('reader_started'), false);

  const purchase = app.slice(app.indexOf('const handleStripePurchase'), app.indexOf('const dismissLegacyNotice'));
  assert.match(purchase, /startCheckout\(type\)/);
  assert.equal(purchase.includes('reportEvent'), false);
});
