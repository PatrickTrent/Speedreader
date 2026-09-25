import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, clientAddress, PAYMENT_UNAVAILABLE, SUMMARY_UNAVAILABLE, WALLET_MISMATCH } from '../server.js';
import { COMPANY_LINE, applyCompanyMarkup } from '../lib/company.js';
import { isCloudflareAddress } from '../lib/cloudflare-ips.js';
import { CONFIG_RATE_MAX, configLimitApplies } from '../lib/http.js';
import { isGoogleFrontendAddress } from '../lib/google-frontend-ips.js';
import { nodeVersionError } from '../lib/node-version.js';
import { buildSummaryPrompt, SUMMARY_CHAR_LIMIT } from '../lib/summarize.js';
import { creditsToRemove, disputeEffect, groupIp, hashIp, productionConfigError } from '../lib/wallets.js';
import { displayBalance, openPaywallBeforeSummarize } from '../lib/display-balance.js';

const prices = { price_starter: 5, price_pro: 50 };
const priceIds = { SMALL: 'price_starter', LARGE: 'price_pro' };
const amounts = { SMALL: 99, LARGE: 399 };

function paidSession(id, walletId, priceId = 'price_starter', status = 'paid', extra = {}) {
  const pro = priceId === 'price_pro';
  const amount = pro ? 399 : 99;
  return {
    id,
    payment_status: status,
    currency: 'eur',
    amount_total: amount,
    client_reference_id: walletId,
    metadata: { walletId, pack: pro ? 'LARGE' : 'SMALL' },
    payment_intent: { id: `pi_${id}`, latest_charge: { id: `ch_${id}` } },
    line_items: {
      data: [{ quantity: 1, price: { id: priceId, currency: 'eur', unit_amount: amount } }],
    },
    ...extra,
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
          const row = sessions[id];
          if (row instanceof Error) throw row;
          if (!row) throw new Error('missing');
          return row;
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
    amounts,
    webhookSecret: 'whsec_test',
    ipHashSecret: 'test-salt',
    summariesConfigured: true,
    trustCloudflare: false,
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, { dataDir, app });
  } finally {
    app.closeStore();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function newId() {
  return crypto.randomUUID();
}

async function getWallet(base, walletId, headers = {}) {
  const res = await fetch(`${base}/api/wallet`, {
    headers: { 'x-wallet-id': walletId, ...headers },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function summarize(base, walletId, text = 'een document', headers = {}) {
  const res = await fetch(`${base}/api/summarize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ walletId, text }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function postWebhook(base, event, signature = 't') {
  const res = await fetch(`${base}/api/stripe-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(event),
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('a wallet read that fails is an unknown balance and does not open the paywall', () => {
  assert.equal(displayBalance({ error: 'rate_limited' }), null);
  assert.equal(displayBalance(null), null);
  assert.equal(displayBalance({}), null);
  assert.equal(displayBalance({ exists: false, freeEligible: true }), 2);
  assert.equal(displayBalance({ exists: true, balance: 0 }), 0);
  assert.equal(displayBalance({ exists: true, balance: 5 }), 5);
  assert.equal(openPaywallBeforeSummarize(null), false);
  assert.equal(openPaywallBeforeSummarize(0), true);
  assert.equal(openPaywallBeforeSummarize(1), false);
});

test('buildSummaryPrompt keeps the model prompt and 35000 character cap', () => {
  const prompt = buildSummaryPrompt('x'.repeat(40000));
  assert.equal(
    prompt,
    `Taak: Vat dit document samen voor een snellezer. Focus op kernboodschappen. Gebruik maximaal 600 woorden. Document: ${'x'.repeat(SUMMARY_CHAR_LIMIT)}`,
  );
});

test('IPv6 is grouped by /64 and hashed with a salt', () => {
  assert.equal(groupIp('not-an-ip'), null);
  assert.equal(groupIp(''), null);
  assert.equal(groupIp('203.0.113.9'), '203.0.113.9');
  assert.equal(groupIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(groupIp('2001:db8:aaaa:bbbb::1'), groupIp('2001:db8:aaaa:bbbb:cccc::9'));
  assert.notEqual(groupIp('2001:db8:aaaa:bbbb::1'), groupIp('2001:db8:aaaa:cccc::1'));
  const a = hashIp('203.0.113.9', 'salt-a');
  const b = hashIp('203.0.113.9', 'salt-b');
  assert.notEqual(a, b);
  assert.equal(a, hashIp('203.0.113.9', 'salt-a'));
  const v6 = groupIp('2001:db8:aaaa:bbbb::1');
  assert.equal(groupIp(v6), v6);
  assert.equal(hashIp('2001:db8:aaaa:bbbb::1', 'salt-a'), hashIp(v6, 'salt-a'));
  assert.notEqual(hashIp(v6, 'salt-a'), hashIp('2001:db8:cccc:dddd::1', 'salt-a'));
  assert.equal(a.length, 64);
});

test('node older than 22.13 is rejected before sqlite is loaded', () => {
  assert.equal(nodeVersionError('22.14.0'), null);
  assert.equal(nodeVersionError('22.13.0'), null);
  assert.match(nodeVersionError('22.12.9'), /too old/);
  assert.match(nodeVersionError('20.11.0'), /too old/);
  const entry = fs.readFileSync(path.resolve('server.js'), 'utf8');
  assert.ok(entry.includes("await import('./lib/http.js')"));
  assert.equal(entry.includes('node:sqlite'), false);
});

test('Cloudflare ranges accept published edges and reject a spoofed socket', () => {
  assert.equal(isCloudflareAddress('104.16.1.2'), true);
  assert.equal(isCloudflareAddress('::ffff:104.16.1.2'), true);
  assert.equal(isCloudflareAddress('127.0.0.1'), false);
  assert.equal(isCloudflareAddress('203.0.113.10'), false);
  const spoof = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.10' } };
  assert.equal(clientAddress(spoof, true), '127.0.0.1');
  const edge = { socket: { remoteAddress: '104.16.1.2' }, headers: { 'cf-connecting-ip': '203.0.113.10' } };
  assert.equal(clientAddress(edge, true), '203.0.113.10');
  const badHeader = { socket: { remoteAddress: '104.16.1.2' }, headers: { 'cf-connecting-ip': 'not-an-ip' } };
  assert.equal(clientAddress(badHeader, true), '104.16.1.2');
  const secret = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '198.51.100.8', 'x-origin-secret': 's3cret' } };
  assert.equal(clientAddress(secret, true, 's3cret'), '198.51.100.8');
  assert.equal(clientAddress(secret, true, 'other'), '127.0.0.1');
  const secretBlocksEdge = { socket: { remoteAddress: '104.16.1.2' }, headers: { 'cf-connecting-ip': '203.0.113.10' } };
  assert.equal(clientAddress(secretBlocksEdge, true, 's3cret'), '104.16.1.2');
  assert.equal(isGoogleFrontendAddress('35.191.1.2'), true);
  assert.equal(isGoogleFrontendAddress('130.211.3.255'), true);
  assert.equal(isGoogleFrontendAddress('130.211.4.1'), false);
  assert.equal(isGoogleFrontendAddress('35.190.1.1'), false);
  assert.equal(isGoogleFrontendAddress('169.254.8.1'), true);
  assert.equal(isGoogleFrontendAddress('169.255.0.1'), false);
  const google = {
    socket: { remoteAddress: '35.191.1.2' },
    headers: {
      'x-origin-secret': 's3cret',
      'x-forwarded-for': '203.0.113.10, 104.16.1.2',
    },
  };
  assert.equal(clientAddress(google, true, 's3cret', { trustForwardedFrom: 'google' }), '203.0.113.10');
  const googleNoSecret = { socket: { remoteAddress: '130.211.0.5' }, headers: { 'x-forwarded-for': '203.0.113.10' } };
  assert.equal(clientAddress(googleNoSecret, true, '', { trustForwardedFrom: 'google' }), '130.211.0.5');
  const cloudRun = {
    socket: { remoteAddress: '169.254.8.1' },
    headers: {
      'x-origin-secret': 's3cret',
      'x-forwarded-for': '203.0.113.10, 35.191.1.2',
    },
  };
  assert.equal(clientAddress(cloudRun, true, 's3cret', { trustForwardedFrom: 'google' }), '203.0.113.10');
  const cloudRunNoSecret = { socket: { remoteAddress: '169.254.8.1' }, headers: { 'x-forwarded-for': '203.0.113.10' } };
  assert.equal(clientAddress(cloudRunNoSecret, true, '', { trustForwardedFrom: 'google' }), '169.254.8.1');
  assert.equal(configLimitApplies('169.254.8.1', { originSecret: '', nodeEnv: 'production' }), false);
  const notGoogle = { socket: { remoteAddress: '203.0.113.4' }, headers: { 'x-origin-secret': 's3cret', 'x-forwarded-for': '198.51.100.8' } };
  assert.equal(clientAddress(notGoogle, true, 's3cret', { trustForwardedFrom: 'google' }), '203.0.113.4');
  assert.equal(configLimitApplies('35.191.1.2', { originSecret: '', nodeEnv: 'production' }), false);
  assert.equal(configLimitApplies('127.0.0.1', { originSecret: '', nodeEnv: 'production' }), true);
  assert.equal(configLimitApplies('104.16.1.2', { originSecret: '', nodeEnv: 'production' }), true);
  assert.equal(configLimitApplies('35.191.1.2', { originSecret: 's3cret', nodeEnv: 'production' }), true);
  assert.equal(disputeEffect('warning_needs_response', 'charge.dispute.created'), 'record');
  assert.equal(disputeEffect('needs_response', 'charge.dispute.created'), 'deduct');
  assert.equal(disputeEffect('needs_response', 'charge.dispute.funds_withdrawn'), 'deduct');
  assert.equal(disputeEffect('warning_closed', 'charge.dispute.closed'), 'restore');
  assert.equal(disputeEffect('won', 'charge.dispute.closed'), 'restore');
  assert.equal(disputeEffect('lost', 'charge.dispute.closed'), 'record');
  assert.equal(CONFIG_RATE_MAX, 600);
});

test('production refuses a missing or in-app DATA_DIR and a missing IP hash secret', () => {
  assert.equal(productionConfigError({ nodeEnv: 'development' }), null);
  assert.equal(productionConfigError({ nodeEnv: 'test', dataDir: '', ipHashSecret: '' }), null);
  assert.match(productionConfigError({ nodeEnv: 'staging', dataDir: '', ipHashSecret: 's' }), /DATA_DIR is unset/);
  assert.match(productionConfigError({ nodeEnv: 'production', dataDir: '', ipHashSecret: 's' }), /DATA_DIR is unset/);
  assert.match(
    productionConfigError({
      nodeEnv: 'production',
      dataDir: '/tmp/app/data',
      ipHashSecret: 's',
      appRoot: '/tmp/app',
      cwd: '/tmp/elsewhere',
    }),
    /inside the deploy directory/,
  );
  assert.match(
    productionConfigError({
      nodeEnv: 'production',
      dataDir: '/var/lib/speedreader',
      ipHashSecret: '',
      appRoot: '/opt/speedreader',
      cwd: '/opt/speedreader',
    }),
    /IP_HASH_SECRET is unset/,
  );
  assert.equal(
    productionConfigError({
      nodeEnv: 'production',
      dataDir: '/var/lib/speedreader',
      ipHashSecret: 'salt',
      appRoot: '/opt/speedreader',
      cwd: '/opt/speedreader',
    }),
    null,
  );
});

test('GET /api/wallet does not create a wallet', async () => {
  await withApp({ stripe: mockStripe({}) }, async (base) => {
    const walletId = newId();
    const first = await getWallet(base, walletId);
    const second = await getWallet(base, walletId);
    assert.equal(first.status, 200);
    assert.equal(first.body.exists, false);
    assert.equal(first.body.balance, 0);
    assert.equal(first.body.freeEligible, true);
    assert.equal(second.body.exists, false);
    assert.equal(second.body.balance, 0);
    const queryOnly = await fetch(`${base}/api/wallet?walletId=${encodeURIComponent(walletId)}`);
    assert.equal(queryOnly.status, 400);
    const queryIgnored = await fetch(`${base}/api/wallet?walletId=${encodeURIComponent(newId())}`, {
      headers: { 'x-wallet-id': walletId },
    });
    assert.equal(queryIgnored.status, 200);
    assert.equal((await queryIgnored.json()).walletId, walletId);
  });
});

test('GET /api/config gates payments and summaries', async () => {
  let called = false;
  await withApp({
    stripe: null,
    priceIds: { SMALL: '', LARGE: '' },
    summariesConfigured: false,
    summarize: async () => {
      called = true;
      return 'should not run';
    },
  }, async (base) => {
    const cfg = await fetch(`${base}/api/config`);
    assert.deepEqual(await cfg.json(), { payments: false, summaries: false });
    const walletId = newId();
    const res = await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId, text: 'hallo' }),
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.error, 'summaries_unavailable');
    assert.equal(body.message, SUMMARY_UNAVAILABLE);
    assert.equal(called, false);
    const look = await getWallet(base, walletId);
    assert.equal(look.body.exists, false);
    const checkout = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId, pack: 'SMALL' }),
    });
    const checkoutBody = await checkout.json();
    assert.equal(checkout.status, 503);
    assert.equal(checkoutBody.message, PAYMENT_UNAVAILABLE);
  });

  await withApp({ stripe: mockStripe({}), summariesConfigured: true }, async (base) => {
    const cfg = await fetch(`${base}/api/config`);
    assert.deepEqual(await cfg.json(), { payments: true, summaries: true });
  });
});

test('a database that will not open disables payments and summaries', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await withApp({ failDatabase: true, stripe: mockStripe({}) }, async (base) => {
      const cfg = await fetch(`${base}/api/config`);
      assert.deepEqual(await cfg.json(), { payments: false, summaries: false });
    });
  } finally {
    console.error = orig;
  }
  assert.ok(logs.some((line) => line.includes('WALLET DATABASE FAILED')));
});

test('claim is idempotent and ignores a client-supplied credit amount', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    const before = await getWallet(base, walletId);
    assert.equal(before.body.exists, false);
    sessions.cs_test_once = paidSession('cs_test_once', walletId);

    const first = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_once', walletId, credits: 9999 }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.balance, 5);
    assert.equal(firstBody.creditsAdded, 5);
    assert.equal(firstBody.alreadyClaimed, false);

    const second = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_once', walletId, credits: 9999 }),
    });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.balance, 5);
    assert.equal(secondBody.creditsAdded, 0);
    assert.equal(secondBody.alreadyClaimed, true);
    const after = await getWallet(base, walletId);
    assert.equal(after.body.exists, true);
    assert.equal(after.body.balance, 5);
  });
});

test('parallel claims and the webhook credit a session once', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_parallel = paidSession('cs_test_parallel', walletId, 'price_pro');

    const [a, b] = await Promise.all([
      fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_parallel', walletId }),
      }),
      fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_parallel', walletId }),
      }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const after = await getWallet(base, walletId);
    assert.equal(after.body.balance, 50);

    const hook = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_parallel' } },
    });
    assert.equal(hook.status, 200);
    const again = await getWallet(base, walletId);
    assert.equal(again.body.balance, 50);
  });
});

test('async_payment_succeeded credits once, the same as a paid completion', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_async = paidSession('cs_test_async', walletId);
    const first = await postWebhook(base, {
      type: 'checkout.session.async_payment_succeeded',
      data: { object: { id: 'cs_test_async' } },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.received, true);
    const mid = await getWallet(base, walletId);
    assert.equal(mid.body.balance, 5);

    const second = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_async' } },
    });
    assert.equal(second.status, 200);
    const after = await getWallet(base, walletId);
    assert.equal(after.body.balance, 5);
  });
});

test('an unpaid or mismatched session is rejected and does not drop credits', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions), summarize: async () => 'korte samenvatting' }, async (base) => {
    const walletId = newId();
    const funded = await summarize(base, walletId);
    assert.equal(funded.status, 200);
    assert.equal(funded.body.balance, 1);

    sessions.cs_test_unpaid = paidSession('cs_test_unpaid', walletId, 'price_starter', 'unpaid');
    const unpaid = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_unpaid', walletId }),
    });
    const unpaidBody = await unpaid.json();
    assert.equal(unpaid.status, 400);
    assert.equal(unpaidBody.error, 'payment_not_paid');
    assert.equal((await getWallet(base, walletId)).body.balance, 1);

    const stranger = newId();
    sessions.cs_test_other = paidSession('cs_test_other', walletId);
    const mismatch = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_other', walletId: stranger }),
    });
    const mismatchBody = await mismatch.json();
    assert.equal(mismatch.status, 403);
    assert.equal(mismatchBody.error, 'wallet_mismatch');
    assert.equal(mismatchBody.message, WALLET_MISMATCH);
    assert.equal((await getWallet(base, walletId)).body.balance, 6);
    assert.equal((await getWallet(base, stranger)).body.exists, false);

    sessions.cs_test_cheap = paidSession('cs_test_cheap', walletId, 'price_starter', 'paid', { amount_total: 1 });
    const cheap = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_cheap', walletId }),
    });
    assert.equal(cheap.status, 400);
    assert.equal((await cheap.json()).error, 'invalid_session');
    assert.equal((await getWallet(base, walletId)).body.balance, 6);
  });
});

test('a refund or dispute removes the purchased credits and does not go negative', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions), summarize: async () => 'korte samenvatting' }, async (base) => {
    const walletId = newId();
    sessions.cs_test_refund = paidSession('cs_test_refund', walletId);
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_refund', walletId }),
    });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).balance, 5);
    assert.equal((await summarize(base, walletId)).body.balance, 4);
    assert.equal((await summarize(base, walletId)).body.balance, 3);

    const refund = await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_refund', amount: 99, amount_refunded: 99, payment_intent: 'pi_cs_test_refund' } },
    });
    assert.equal(refund.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 0);

    const dispute = await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_refund', amount: 99, payment_intent: 'pi_cs_test_refund', status: 'needs_response' } },
    });
    assert.equal(dispute.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
  });
});

test('ignored webhook events return 200 and a bad signature returns 400', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const other = await postWebhook(base, { type: 'customer.created', data: { object: {} } });
    assert.equal(other.status, 200);
    assert.equal(other.body.received, true);

    const walletId = newId();
    sessions.cs_test_unknown = paidSession('cs_test_unknown', walletId, 'price_other');
    const unknown = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_unknown' } },
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.credited, false);
    assert.equal((await getWallet(base, walletId)).body.exists, false);

    sessions.cs_test_nowallet = paidSession('cs_test_nowallet', 'not-a-wallet');
    const missing = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_nowallet' } },
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.credited, false);

    const bad = await postWebhook(base, { type: 'checkout.session.completed', data: { object: { id: 'cs_x' } } }, 'nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_signature');
  });
});

test('a credit is deducted only after a successful summary', async () => {
  let calls = 0;
  const summarizeFn = async (text) => {
    calls += 1;
    assert.ok(text.length <= SUMMARY_CHAR_LIMIT);
    if (calls === 1) throw new Error('gemini down');
    return 'korte samenvatting';
  };
  await withApp({ stripe: mockStripe({}), summarize: summarizeFn }, async (base) => {
    const walletId = newId();
    const fail = await summarize(base, walletId, 'woord '.repeat(100));
    assert.equal(fail.status, 502);
    assert.equal(fail.body.balance, 2);
    assert.equal((await getWallet(base, walletId)).body.exists, true);

    const ok = await summarize(base, walletId, 'y'.repeat(40000));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.summary, 'KORTE SAMENVATTING');
    assert.equal(ok.body.balance, 1);
    assert.equal(calls, 2);

    await summarize(base, walletId, 'nog een');
    const broke = await summarize(base, walletId, 'geen credits');
    assert.equal(broke.status, 402);
    assert.equal(broke.body.error, 'no_credits');
    assert.equal(broke.body.balance, 0);
    assert.equal(calls, 3);
  });
});

test('a timed-out summary refunds the reserved credit', async () => {
  await withApp({
    stripe: mockStripe({}),
    summaryTimeoutMs: 40,
    summarize: () => new Promise(() => {}),
  }, async (base) => {
    const walletId = newId();
    const res = await summarize(base, walletId);
    assert.equal(res.status, 504);
    assert.equal(res.body.error, 'summary_timeout');
    assert.equal(res.body.message, SUMMARY_UNAVAILABLE);
    assert.equal(res.body.balance, 2);
  });
});

test('X-Forwarded-For is ignored and Cloudflare is used only when trusted', async () => {
  const summarizeFn = async () => 'korte samenvatting';
  await withApp({ stripe: mockStripe({}), freeWalletCap: 1, summarize: summarizeFn, trustCloudflare: false }, async (base, { dataDir }) => {
    const first = newId();
    const second = newId();
    const ok = await summarize(base, first, 'een', { 'x-forwarded-for': '203.0.113.10', 'cf-connecting-ip': '198.51.100.8' });
    assert.equal(ok.status, 200);
    const blocked = await summarize(base, second, 'twee', { 'x-forwarded-for': '203.0.113.99', 'cf-connecting-ip': '198.51.100.9' });
    assert.equal(blocked.status, 402);
    assert.equal((await getWallet(base, second)).body.exists, false);
    const raw = fs.readFileSync(path.join(dataDir, 'wallets.sqlite'));
    const wal = path.join(dataDir, 'wallets.sqlite-wal');
    const blob = raw.toString('latin1') + (fs.existsSync(wal) ? fs.readFileSync(wal).toString('latin1') : '');
    assert.equal(blob.includes('203.0.113.10'), false);
    assert.equal(blob.includes('198.51.100.8'), false);
  });

  const edge = { 'x-origin-secret': 'edge-secret' };
  await withApp({
    stripe: mockStripe({}),
    freeWalletCap: 1,
    summarize: summarizeFn,
    trustCloudflare: true,
    originSecret: 'edge-secret',
  }, async (base) => {
    const a = newId();
    const b = newId();
    const c = newId();
    assert.equal((await summarize(base, a, 'a', { ...edge, 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '1.1.1.1' })).status, 200);
    assert.equal((await summarize(base, b, 'b', { ...edge, 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '8.8.8.8' })).status, 402);
    assert.equal((await summarize(base, c, 'c', { ...edge, 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '203.0.113.10' })).status, 200);

    const v6a = newId();
    const v6b = newId();
    const v6c = newId();
    assert.equal((await summarize(base, v6a, 'a', { ...edge, 'cf-connecting-ip': '2001:db8:aaaa:bbbb::1' })).status, 200);
    assert.equal((await summarize(base, v6b, 'b', { ...edge, 'cf-connecting-ip': '2001:db8:aaaa:bbbb:cccc::2' })).status, 402);
    assert.equal((await summarize(base, v6c, 'c', { ...edge, 'cf-connecting-ip': '2001:db8:cccc:dddd::1' })).status, 200);
  });
});

test('a spoofed CF-Connecting-IP from a non-Cloudflare socket gets no extra free wallets', async () => {
  await withApp({
    stripe: mockStripe({}),
    freeWalletCap: 1,
    trustCloudflare: true,
    summarize: async () => 'korte samenvatting',
  }, async (base) => {
    const first = newId();
    const second = newId();
    assert.equal((await summarize(base, first, 'een', { 'cf-connecting-ip': '203.0.113.10' })).status, 200);
    const blocked = await summarize(base, second, 'twee', { 'cf-connecting-ip': '198.51.100.50' });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.error, 'no_credits');
    assert.equal((await getWallet(base, second)).body.exists, false);
  });
});

test('free grants reset after 24 hours and idle free wallets are pruned after 180 days', async () => {
  let nowMs = Date.parse('2024-01-01T00:00:00.000Z');
  const now = () => new Date(nowMs);
  await withApp({
    stripe: mockStripe({}),
    freeWalletCap: 1,
    summarize: async () => 'korte samenvatting',
    now,
  }, async (base) => {
    const first = newId();
    const second = newId();
    const third = newId();
    assert.equal((await summarize(base, first)).status, 200);
    assert.equal((await summarize(base, second)).status, 402);
    assert.equal((await getWallet(base, second)).body.exists, false);
    nowMs += 25 * 60 * 60 * 1000;
    assert.equal((await summarize(base, third)).status, 200);
    assert.equal((await getWallet(base, first)).body.exists, true);
  });
});

test('paid wallets survive the 180 day prune', async () => {
  let nowMs = Date.parse('2024-06-01T00:00:00.000Z');
  const sessions = {};
  await withApp({
    stripe: mockStripe(sessions),
    summarize: async () => 'korte samenvatting',
    now: () => new Date(nowMs),
    exposeInternals: true,
    pruneIntervalMs: 60 * 60 * 1000,
  }, async (base, { app, dataDir }) => {
    const freeId = newId();
    const paidId = newId();
    assert.equal((await summarize(base, freeId)).status, 200);
    sessions.cs_test_keep = paidSession('cs_test_keep', paidId);
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_keep', walletId: paidId }),
    });
    assert.equal(claim.status, 200);
    nowMs += 181 * 24 * 60 * 60 * 1000;
    assert.equal((await getWallet(base, freeId)).body.exists, true);
    app.pruneNow();
    assert.equal((await getWallet(base, freeId)).body.exists, false);
    const paidLook = await getWallet(base, paidId);
    assert.equal(paidLook.body.exists, true);
    assert.equal(paidLook.body.balance, 5);
    nowMs += 3 * 365 * 24 * 60 * 60 * 1000;
    app.pruneNow();
    assert.equal((await getWallet(base, paidId)).body.exists, true);
    assert.equal((await getWallet(base, paidId)).body.balance, 5);
    for (let i = 0; i < 5; i += 1) assert.equal((await summarize(base, paidId)).status, 200);
    assert.equal((await getWallet(base, paidId)).body.balance, 0);
    nowMs += (3 * 365 + 1) * 24 * 60 * 60 * 1000;
    app.pruneNow();
    assert.equal((await getWallet(base, paidId)).body.exists, false);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'wallets.sqlite'), { readOnly: true });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
    db.close();
    assert.ok(names.includes('idx_wallets_activity'));
  });
});

test('a paid wallet with a claim inside the dispute window is not pruned', async () => {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const sessions = {};
  await withApp({
    stripe: mockStripe(sessions),
    summarize: async () => 'korte samenvatting',
    now: () => new Date(nowMs),
    exposeInternals: true,
  }, async (base, { app, dataDir }) => {
    const walletId = newId();
    sessions.cs_test_window = paidSession('cs_test_window', walletId);
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_window', walletId }),
    });
    assert.equal(claim.status, 200);
    for (let i = 0; i < 5; i += 1) assert.equal((await summarize(base, walletId)).status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'wallets.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000');
    const oldActivity = new Date(nowMs - (4 * 365 * 24 * 60 * 60 * 1000)).toISOString();
    db.prepare('UPDATE wallets SET last_activity_at = ? WHERE id = ?').run(oldActivity, walletId);
    db.close();
    app.pruneNow();
    assert.equal((await getWallet(base, walletId)).body.exists, true);
    const db2 = new DatabaseSync(path.join(dataDir, 'wallets.sqlite'));
    db2.exec('PRAGMA busy_timeout = 5000');
    const oldClaim = new Date(nowMs - (181 * 24 * 60 * 60 * 1000)).toISOString();
    db2.prepare('UPDATE claims SET created_at = ? WHERE wallet_id = ?').run(oldClaim, walletId);
    db2.close();
    app.pruneNow();
    assert.equal((await getWallet(base, walletId)).body.exists, false);
  });
});

test('checkout session carries the wallet and does not credit by itself', async () => {
  const hooks = {};
  await withApp({ stripe: mockStripe({}, hooks) }, async (base) => {
    const walletId = newId();
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId, pack: 'SMALL' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_created');
    assert.equal(hooks.created.client_reference_id, walletId);
    assert.equal(hooks.created.metadata.walletId, walletId);
    assert.equal(hooks.created.success_url, 'https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(hooks.created.line_items[0].price, 'price_starter');
    assert.deepEqual(hooks.created.payment_method_types, ['card', 'ideal', 'bancontact']);
    const look = await getWallet(base, walletId);
    assert.equal(look.body.exists, false);
    assert.equal(look.body.balance, 0);
  });
});

test('rate-limiter maps drop idle keys', async () => {
  await withApp({
    stripe: mockStripe({}),
    exposeInternals: true,
    rateLimits: {
      wallet: { windowMs: 40, max: 2, pruneEveryMs: 15 },
    },
  }, async (base, { app }) => {
    const walletId = newId();
    assert.equal((await getWallet(base, walletId)).status, 200);
    assert.equal((await getWallet(base, walletId)).status, 200);
    assert.equal((await getWallet(base, walletId)).status, 429);
    assert.ok(app.limiterSize('wallet') >= 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(app.limiterSize('wallet'), 0);
  });
});

test('production error responses omit stacks', async () => {
  await withApp({ stripe: mockStripe({}), nodeEnv: 'production' }, async (base) => {
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.equal(text.includes('stack'), false);
    assert.equal(text.includes('SyntaxError'), false);
    assert.deepEqual(JSON.parse(text), { error: 'server_error' });
  });
});

test('refunds are proportional and cumulative, and a won dispute restores credits', async () => {
  assert.equal(creditsToRemove(50, 200, 399), 25);
  assert.equal(creditsToRemove(50, 399, 399), 50);
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_part = paidSession('cs_test_part', walletId, 'price_pro');
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_part', walletId }),
    });
    assert.equal((await claim.json()).balance, 50);

    const partial = await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_part', amount: 399, amount_refunded: 200, payment_intent: 'pi_cs_test_part' } },
    });
    assert.equal(partial.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 25);
    const again = await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_part', amount: 399, amount_refunded: 200, payment_intent: 'pi_cs_test_part' } },
    });
    assert.equal(again.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 25);
    await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_part', amount: 399, amount_refunded: 399, payment_intent: 'pi_cs_test_part' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
  });

  const disputeSessions = {};
  await withApp({ stripe: mockStripe(disputeSessions) }, async (base) => {
    const walletId = newId();
    disputeSessions.cs_test_dispute = paidSession('cs_test_dispute', walletId);
    await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_dispute', walletId }),
    });
    await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_dispute', amount: 99, payment_intent: 'pi_cs_test_dispute', status: 'needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
    const won = await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_dispute', amount: 99, payment_intent: 'pi_cs_test_dispute', status: 'won' } },
    });
    assert.equal(won.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    const wonAgain = await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_dispute', amount: 99, payment_intent: 'pi_cs_test_dispute', status: 'won' } },
    });
    assert.equal(wonAgain.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
  });
});

test('a refund or dispute before the claim credits only the net amount', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const full = newId();
    sessions.cs_test_early_full = paidSession('cs_test_early_full', full);
    const early = await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_early_full', amount: 99, amount_refunded: 99, payment_intent: 'pi_cs_test_early_full' } },
    });
    assert.equal(early.status, 200);
    const fullClaim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_early_full', walletId: full }),
    });
    const fullBody = await fullClaim.json();
    assert.equal(fullClaim.status, 200);
    assert.equal(fullBody.creditsAdded, 0);
    assert.equal(fullBody.balance, 0);

    const partial = newId();
    sessions.cs_test_early_part = paidSession('cs_test_early_part', partial);
    await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_early_part', amount: 99, amount_refunded: 50, payment_intent: 'pi_cs_test_early_part' } },
    });
    const partialClaim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_early_part', walletId: partial }),
    });
    assert.equal((await partialClaim.json()).creditsAdded, 3);

    const disputed = newId();
    sessions.cs_test_early_dp = paidSession('cs_test_early_dp', disputed);
    await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_early_dp', amount: 99, payment_intent: 'pi_cs_test_early_dp', status: 'needs_response' } },
    });
    const disputeClaim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_early_dp', walletId: disputed }),
    });
    assert.equal((await disputeClaim.json()).creditsAdded, 0);
    await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_early_dp', amount: 99, payment_intent: 'pi_cs_test_early_dp', status: 'won' } },
    });
    assert.equal((await getWallet(base, disputed)).body.balance, 5);
  });
});

test('a replayed refund keeps the target and does not deduct a later purchase', async () => {
  const sessions = {};
  const logs = [];
  const orig = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    await withApp({ stripe: mockStripe(sessions), summarize: async () => 'korte samenvatting' }, async (base) => {
      const walletId = newId();
      sessions.cs_test_floor = paidSession('cs_test_floor', walletId);
      const first = await fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_floor', walletId }),
      });
      assert.equal((await first.json()).balance, 5);
      for (let i = 0; i < 5; i += 1) assert.equal((await summarize(base, walletId)).status, 200);
      assert.equal((await getWallet(base, walletId)).body.balance, 0);
      const event = {
        type: 'charge.refunded',
        data: { object: { id: 'ch_cs_test_floor', amount: 99, amount_refunded: 99, payment_intent: 'pi_cs_test_floor' } },
      };
      assert.equal((await postWebhook(base, event)).status, 200);
      assert.equal((await getWallet(base, walletId)).body.balance, 0);
      sessions.cs_test_floor2 = paidSession('cs_test_floor2', walletId);
      const second = await fetch(`${base}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_floor2', walletId }),
      });
      assert.equal((await second.json()).balance, 5);
      assert.equal((await postWebhook(base, event)).status, 200);
      assert.equal((await getWallet(base, walletId)).body.balance, 5);
      assert.equal(logs.some((line) => line.includes(walletId)), false);
    });
  } finally {
    console.error = orig;
  }
});

test('warning disputes do not deduct, and warning_closed restores once', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_warn = paidSession('cs_test_warn', walletId);
    await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_warn', walletId }),
    });
    await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'warning_needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.dispute.funds_withdrawn',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'warning_needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.dispute.funds_withdrawn',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
    const closed = await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'warning_closed' } },
    });
    assert.equal(closed.status, 200);
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'warning_closed' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_warn', amount: 99, payment_intent: 'pi_cs_test_warn', status: 'needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
  });
});

test('a full refund after a won dispute removes the restored credits', async () => {
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_won_refund = paidSession('cs_test_won_refund', walletId);
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_won_refund', walletId }),
    });
    assert.equal((await claim.json()).balance, 5);
    await postWebhook(base, {
      type: 'charge.dispute.created',
      data: { object: { charge: 'ch_cs_test_won_refund', amount: 99, payment_intent: 'pi_cs_test_won_refund', status: 'needs_response' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 0);
    await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_won_refund', amount: 99, payment_intent: 'pi_cs_test_won_refund', status: 'won' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_won_refund', amount: 99, amount_refunded: 99, payment_intent: 'pi_cs_test_won_refund' } },
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 0);

    const warned = newId();
    sessions.cs_test_warn_refund = paidSession('cs_test_warn_refund', warned);
    await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_warn_refund', walletId: warned }),
    });
    await postWebhook(base, {
      type: 'charge.dispute.funds_withdrawn',
      data: { object: { charge: 'ch_cs_test_warn_refund', amount: 99, payment_intent: 'pi_cs_test_warn_refund', status: 'needs_response' } },
    });
    assert.equal((await getWallet(base, warned)).body.balance, 0);
    await postWebhook(base, {
      type: 'charge.dispute.closed',
      data: { object: { charge: 'ch_cs_test_warn_refund', amount: 99, payment_intent: 'pi_cs_test_warn_refund', status: 'warning_closed' } },
    });
    assert.equal((await getWallet(base, warned)).body.balance, 5);
    await postWebhook(base, {
      type: 'charge.refunded',
      data: { object: { id: 'ch_cs_test_warn_refund', amount: 99, amount_refunded: 99, payment_intent: 'pi_cs_test_warn_refund' } },
    });
    assert.equal((await getWallet(base, warned)).body.balance, 0);
  });
});

test('a Stripe 404 is ignored by the webhook and rejected by claim', async () => {
  const missing = new Error('No such checkout.session');
  missing.code = 'resource_missing';
  missing.statusCode = 404;
  const sessions = { cs_test_gone: missing };
  await withApp({ stripe: mockStripe(sessions) }, async (base) => {
    const hook = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_gone' } },
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.credited, false);
    const walletId = newId();
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_gone', walletId }),
    });
    assert.equal(claim.status, 400);
    assert.equal((await claim.json()).error, 'session_not_found');
  });
});

test('a session older than 30 days cannot be claimed', async () => {
  const nowMs = Date.parse('2026-09-25T00:00:00.000Z');
  const sessions = {};
  await withApp({ stripe: mockStripe(sessions), now: () => new Date(nowMs) }, async (base) => {
    const walletId = newId();
    sessions.cs_test_stale = paidSession('cs_test_stale', walletId, 'price_starter', 'paid', {
      created: Math.floor((nowMs - 31 * 24 * 60 * 60 * 1000) / 1000),
    });
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_stale', walletId }),
    });
    assert.equal(claim.status, 400);
    assert.equal((await claim.json()).error, 'session_expired');
    assert.equal((await getWallet(base, walletId)).body.exists, false);
    const hook = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_stale' } },
    });
    assert.equal(hook.status, 200);
    assert.equal(hook.body.credited, false);
  });
});

test('a failed Stripe retrieve makes the webhook return 500', async () => {
  await withApp({ stripe: mockStripe({}) }, async (base) => {
    const missing = await postWebhook(base, {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_missing' } },
    });
    assert.equal(missing.status, 500);
    assert.equal(missing.body.error, 'webhook_failed');
  });
});

test('claims older than 7 years are pruned and a wallet id is stored in lowercase', async () => {
  let nowMs = Date.parse('2020-01-01T00:00:00.000Z');
  const sessions = {};
  await withApp({
    stripe: mockStripe(sessions),
    exposeInternals: true,
    pruneIntervalMs: 60 * 60 * 1000,
    now: () => new Date(nowMs),
    summarize: async () => 'korte samenvatting',
  }, async (base, { app, dataDir }) => {
    const walletId = newId();
    const upper = walletId.toUpperCase();
    const created = await summarize(base, upper);
    assert.equal(created.status, 200);
    assert.equal((await getWallet(base, walletId)).body.exists, true);
    assert.equal((await getWallet(base, walletId)).body.balance, 1);

    sessions.cs_test_old = paidSession('cs_test_old', walletId);
    await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_old', walletId: upper }),
    });
    assert.equal((await getWallet(base, walletId)).body.balance, 6);
    nowMs += (7 * 365 + 2) * 24 * 60 * 60 * 1000;
    app.pruneNow();
    const again = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_old', walletId }),
    });
    const body = await again.json();
    assert.equal(again.status, 200);
    assert.equal(body.alreadyClaimed, true);
    assert.equal(body.creditsAdded, 0);
    assert.equal(body.balance, 6);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'wallets.sqlite'), { readOnly: true });
    const tomb = db.prepare('SELECT * FROM claim_tombstones WHERE session_id = ?').get('cs_test_old');
    const claimRow = db.prepare('SELECT session_id FROM claims WHERE session_id = ?').get('cs_test_old');
    db.close();
    assert.equal(tomb.claimed, 1);
    assert.equal(tomb.wallet_id, undefined);
    assert.equal(claimRow, undefined);
  });
});

test('a malformed path returns 400, a bad query is served, and config can be limited', async () => {
  await withApp({
    stripe: mockStripe({}),
    rateLimits: { config: { windowMs: 60_000, max: 2, pruneEveryMs: 60_000 } },
  }, async (base) => {
    const bad = await fetch(`${base}/%zz/`);
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.error, 'bad_request');
    const query = await fetch(`${base}/?utm=%`);
    assert.notEqual(query.status, 400);
    assert.notEqual(query.status, 500);
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 429);
  });
});

test('a symlink DATA_DIR inside the repo is refused and an unwritable path fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sr-root-'));
  mkdirSync(path.join(root, 'inside'));
  const link = path.join(tmpdir(), `sr-link-${crypto.randomUUID()}`);
  symlinkSync(path.join(root, 'inside'), link);
  try {
    const err = productionConfigError({
      nodeEnv: 'production',
      dataDir: link,
      ipHashSecret: 'salt',
      appRoot: root,
      cwd: path.join(tmpdir(), 'not-the-app'),
    });
    assert.match(err, /inside the deploy directory/);
  } finally {
    rmSync(link);
    rmSync(root, { recursive: true, force: true });
  }

  const blocked = path.join(tmpdir(), `sr-file-${crypto.randomUUID()}`);
  writeFileSync(blocked, 'not-a-directory');
  const logs = [];
  const orig = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    await withApp({ dataDir: blocked, stripe: mockStripe({}), failDatabase: false }, async (base) => {
      const cfg = await fetch(`${base}/api/config`);
      assert.deepEqual(await cfg.json(), { payments: false, summaries: false });
    });
  } finally {
    console.error = orig;
    rmSync(blocked, { force: true });
  }
  assert.ok(logs.some((line) => line.includes('WALLET DATABASE FAILED')));
});

test('the app never redirects to a Payment Link', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  const intent = fs.readFileSync(path.resolve('public/ai-summary/index.html'), 'utf8');
  const privacy = fs.readFileSync(path.resolve('public/privacy/index.html'), 'utf8');
  assert.equal(app.includes('buy.stripe.com'), false);
  assert.equal(app.includes('checkout='), false);
  assert.equal(intent.includes('buy.stripe.com'), false);
  assert.equal(intent.includes('checkout='), false);
  assert.ok(intent.includes('/?buy=starter'));
  assert.ok(intent.includes('/?buy=pro'));
  assert.ok(intent.includes('/#reader'));
  assert.ok(app.includes(PAYMENT_UNAVAILABLE));
  assert.ok(app.includes(SUMMARY_UNAVAILABLE));
  assert.ok(app.includes('speedreader@agentmail.to'));
  assert.ok(app.includes('creditNoticeSeen'));
  assert.equal(app.includes("localStorage.setItem('creditBalance'"), false);
  assert.equal(app.includes('await startCheckout(pack)'), false);
  assert.ok(app.includes('Bevestig Pro'));
  assert.equal(intent.toLowerCase().includes('anonymous'), false);
  assert.equal(privacy.toLowerCase().includes('anonymous'), false);
  assert.ok(privacy.includes('payment intent'));
  assert.ok(privacy.includes('cleared on restart'));
  assert.ok(privacy.includes('speedreader@agentmail.to'));
  assert.ok(privacy.includes('180 days'));
  assert.ok(privacy.includes('24 hours'));
  assert.ok(privacy.includes('HMAC'));
  assert.ok(privacy.includes('Google Cloud'));
  assert.ok(privacy.includes('Cloudflare'));
  assert.ok(privacy.includes('7 years'));
  assert.ok(privacy.includes('adjustments table'));
  assert.ok(privacy.includes('3 years'));
  assert.ok(privacy.includes('tombstone'));
  assert.ok(privacy.includes('kept indefinitely'));
  assert.ok(privacy.includes('no personal data'));
  assert.ok(privacy.includes('never put in a URL'));
  assert.ok(privacy.includes('onbeperkt'));
  assert.ok(privacy.includes('nooit in een URL'));
  assert.ok(privacy.includes('30 days'));
  assert.equal(app.includes('?walletId='), false);
  assert.equal(app.includes('req.query.walletId'), false);
  assert.ok(app.includes("'X-Wallet-Id': walletId"));
  assert.ok(app.includes('openPaywallBeforeSummarize'));
  assert.ok(app.includes('setCredits(null)'));
  const http = fs.readFileSync(path.resolve('lib/http.js'), 'utf8');
  assert.equal(http.includes('req.query.walletId'), false);
  assert.ok(http.includes("headerValue(req, 'x-wallet-id')"));
  const deploy = fs.readFileSync(path.resolve('DEPLOY.md'), 'utf8');
  assert.ok(deploy.includes('169.254.0.0/16'));
  assert.ok(deploy.includes('Set, not Add'));
  assert.ok(deploy.includes('`ORIGIN_SECRET` plus a Cloudflare Transform Rule are required'));
  assert.equal(COMPANY_LINE, 'Trentelman AI Solutions, KvK 91686210, btw NL004908763B50, Groningen');
  assert.equal((app.match(/setPendingPack\(null\)/g) || []).length >= 3, true);
  assert.equal(app.includes('setConfig({ payments: false, summaries: false })'), false);
  assert.ok(app.includes('cfgRes.ok'));
  assert.ok(app.includes('COMPANY_LINE'));
  for (const file of [
    'App.tsx',
    'lib/company.js',
    'public/privacy/index.html',
    'public/ai-summary/index.html',
    'public/rsvp/index.html',
    'public/read-long-pdf/index.html',
    'public/for-builders/index.html',
  ]) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    const rendered = file.endsWith('.html') || file.endsWith('company.js') ? applyCompanyMarkup(text) : text;
    assert.equal(rendered.includes('91688621'), false, file);
    assert.equal(/[A-Z]{2}\d{2}[A-Z]{4}\d{10}/.test(rendered), false, file);
    if (file === 'App.tsx') {
      assert.ok(rendered.includes('COMPANY_LINE'), file);
    } else {
      assert.ok(rendered.includes('91686210'), file);
      assert.ok(rendered.includes(COMPANY_LINE), file);
    }
  }
  const privacyFooter = applyCompanyMarkup(privacy).slice(applyCompanyMarkup(privacy).lastIndexOf('<footer'));
  assert.equal(privacyFooter.split('Trentelman AI Solutions').length - 1, 1);
  assert.ok(privacy.includes('is the controller'));
});
