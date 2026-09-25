import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { buildSummaryPrompt, SUMMARY_CHAR_LIMIT } from '../lib/summarize.js';

const prices = { price_starter: 5, price_pro: 50 };
const priceIds = { SMALL: 'price_starter', LARGE: 'price_pro' };

function paidSession(id, walletId, priceId = 'price_starter', status = 'paid') {
  return {
    id,
    payment_status: status,
    client_reference_id: walletId,
    metadata: { walletId, pack: priceId === 'price_pro' ? 'LARGE' : 'SMALL' },
    line_items: { data: [{ price: { id: priceId } }] },
  };
}

function mockStripe(sessions, hooks = {}) {
  return {
    checkout: {
      sessions: {
        async create(params) {
          hooks.created = params;
          return { id: 'cs_test_created', url: 'https://checkout.stripe.com/c/pay/cs_test_created' };
        },
        async retrieve(id) {
          hooks.retrieves = (hooks.retrieves || 0) + 1;
          if (!sessions[id]) throw new Error('missing');
          return sessions[id];
        },
      },
    },
    webhooks: {
      constructEvent(payload, sig, secret) {
        if (sig !== 't' || secret !== 'whsec_test') throw new Error('bad signature');
        const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
        return JSON.parse(raw);
      },
    },
  };
}

async function withApp(opts, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'speedreader-'));
  const app = createApp({
    dataDir,
    prices,
    priceIds,
    webhookSecret: 'whsec_test',
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function openWallet(base) {
  const walletId = crypto.randomUUID();
  const res = await fetch(`${base}/api/wallet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  return { walletId, ...body };
}

async function balanceOf(base, walletId) {
  const res = await fetch(`${base}/api/wallet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  return body.balance;
}

test('buildSummaryPrompt keeps the model prompt and 35000 character cap', () => {
  const prompt = buildSummaryPrompt('x'.repeat(40000));
  assert.equal(
    prompt,
    `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${'x'.repeat(SUMMARY_CHAR_LIMIT)}`,
  );
});

test('claim is idempotent and ignores a client-supplied credit amount', async () => {
  const walletIdHolder = {};
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const wallet = await openWallet(base);
    walletIdHolder.id = wallet.walletId;
    assert.equal(wallet.balance, 2);
    sessions.cs_test_once = paidSession('cs_test_once', wallet.walletId);

    const first = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_once', walletId: wallet.walletId, credits: 9999 }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.balance, 7);
    assert.equal(firstBody.creditsAdded, 5);
    assert.equal(firstBody.alreadyClaimed, false);

    const second = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_once', walletId: wallet.walletId, credits: 9999 }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.balance, 7);
    assert.equal(secondBody.creditsAdded, 0);
    assert.equal(secondBody.alreadyClaimed, true);
    assert.equal(await balanceOf(base, wallet.walletId), 7);
  });
});

test('parallel claims and the webhook credit a session once', async () => {
  const sessions = {};
  const stripe = mockStripe(sessions);
  await withApp({ stripe }, async (base) => {
    const wallet = await openWallet(base);
    sessions.cs_test_parallel = paidSession('cs_test_parallel', wallet.walletId, 'price_pro');

    const [a, b] = await Promise.all([
      fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_parallel', walletId: wallet.walletId }),
      }),
      fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_parallel', walletId: wallet.walletId }),
      }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await balanceOf(base, wallet.walletId), 52);

    const hook = await fetch(`${base}/api/stripe-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_parallel' } },
      }),
    });
    assert.equal(hook.status, 200);
    assert.equal(await balanceOf(base, wallet.walletId), 52);
  });
});

test('an unpaid session is rejected and does not change the balance', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const wallet = await openWallet(base);
    sessions.cs_test_unpaid = paidSession('cs_test_unpaid', wallet.walletId, 'price_starter', 'unpaid');
    const res = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_unpaid', walletId: wallet.walletId }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, 'payment_not_paid');
    assert.equal(await balanceOf(base, wallet.walletId), 2);
  });
});

test('a credit is deducted only after a successful summary', async () => {
  let calls = 0;
  const summarize = async (text) => {
    calls += 1;
    assert.ok(text.length <= SUMMARY_CHAR_LIMIT);
    if (calls === 1) throw new Error('gemini down');
    return 'korte samenvatting';
  };
  await withApp({ stripe: mockStripe({}), summarize }, async (base) => {
    const wallet = await openWallet(base);
    const fail = await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, text: 'woord '.repeat(100) }),
    });
    const failBody = await fail.json();
    assert.equal(fail.status, 502);
    assert.equal(failBody.balance, 2);

    const ok = await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, text: 'y'.repeat(40000) }),
    });
    const okBody = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(okBody.summary, 'KORTE SAMENVATTING');
    assert.equal(okBody.balance, 1);
    assert.equal(calls, 2);

    await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, text: 'nog een' }),
    });
    const broke = await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, text: 'geen credits' }),
    });
    const brokeBody = await broke.json();
    assert.equal(broke.status, 402);
    assert.equal(brokeBody.error, 'no_credits');
    assert.equal(brokeBody.balance, 0);
    assert.equal(calls, 3);
  });
});

test('checkout session carries the wallet and does not credit by itself', async () => {
  const hooks = {};
  await withApp({ stripe: mockStripe({}, hooks) }, async (base) => {
    const wallet = await openWallet(base);
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, pack: 'SMALL' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_created');
    assert.equal(hooks.created.client_reference_id, wallet.walletId);
    assert.equal(hooks.created.metadata.walletId, wallet.walletId);
    assert.equal(hooks.created.success_url, 'https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(hooks.created.line_items[0].price, 'price_starter');
    assert.equal(await balanceOf(base, wallet.walletId), 2);
  });
});

test('checkout without Stripe is unavailable', async () => {
  await withApp({ stripe: null, priceIds: { SMALL: '', LARGE: '' } }, async (base) => {
    const wallet = await openWallet(base);
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: wallet.walletId, pack: 'LARGE' }),
    });
    assert.equal(res.status, 503);
    assert.equal(await balanceOf(base, wallet.walletId), 2);
  });
});

test('free wallets from one IP are capped', async () => {
  await withApp({ stripe: null, freeWalletCap: 2 }, async (base) => {
    const first = await openWallet(base);
    const second = await openWallet(base);
    const third = await openWallet(base);
    assert.equal(first.balance, 2);
    assert.equal(second.balance, 2);
    assert.equal(third.balance, 0);
    const again = await fetch(`${base}/api/wallet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId: first.walletId }),
    });
    const body = await again.json();
    assert.equal(body.balance, 2);
    assert.equal(body.created, false);
  });
});
