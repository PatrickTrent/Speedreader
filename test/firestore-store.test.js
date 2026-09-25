import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server.js';
import { createMemoryFirestore, openFirestoreStore } from '../lib/firestore-store.js';
import {
  CLAIM_RETENTION_MS,
  FREE_CREDITS,
  FREE_WALLET_IDLE_MS,
  FREE_WALLETS_PER_IP,
  PAID_WALLET_IDLE_MS,
  productionConfigError,
} from '../lib/wallets.js';

const secret = 'test-salt';
const origin = 'o'.repeat(32);

function openMem() {
  const client = createMemoryFirestore();
  const store = openFirestoreStore({
    client,
    ipHashSecret: secret,
    pruneIntervalMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(store.ok, true);
  assert.equal(store.kind, 'firestore');
  return { client, store };
}

function walletId() {
  return crypto.randomUUID();
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function purchase(id, extra = {}) {
  return {
    walletId: extra.walletId || walletId(),
    sessionId: extra.sessionId || `cs_test_${id}`,
    credits: 5,
    amountTotal: 99,
    currency: 'eur',
    priceId: 'price_starter',
    chargeId: `ch_${id}`,
    paymentIntentId: `pi_${id}`,
    ...extra,
  };
}

test('production accepts Firestore without DATA_DIR and refuses a bad store', () => {
  const base = {
    nodeEnv: 'production',
    dataDir: '',
    ipHashSecret: secret,
    originSecret: origin,
    appRoot: '/opt/speedreader',
    cwd: '/opt/speedreader',
  };
  assert.match(
    productionConfigError({ ...base, store: 'firestore', firestoreProject: '' }),
    /Firestore project id is unset/,
  );
  assert.equal(
    productionConfigError({ ...base, store: 'firestore', firestoreProject: 'gen-lang-client-0860349793' }),
    null,
  );
  assert.match(
    productionConfigError({ ...base, store: '  Firestore  ', firestoreProject: '' }),
    /Firestore project id is unset/,
  );
  assert.equal(
    productionConfigError({
      nodeEnv: 'production',
      store: 'FIRESTORE',
      dataDir: '',
      ipHashSecret: secret,
      originSecret: `  ${origin}  `,
      firestoreProject: 'gen-lang-client-0860349793',
      appRoot: '/opt/speedreader',
      cwd: '/opt/speedreader',
    }),
    null,
  );
  assert.match(
    productionConfigError({ ...base, store: 'gcs', firestoreProject: 'p' }),
    /STORE=gcs is not sqlite or firestore/,
  );
  assert.match(
    productionConfigError({ ...base, store: 'sqlite', dataDir: '' }),
    /DATA_DIR is unset/,
  );
  assert.match(
    productionConfigError({
      ...base,
      store: 'firestore',
      firestoreProject: 'gen-lang-client-0860349793',
      originSecret: ' abc ',
      directCloudflareOrigin: '1',
    }),
    /shorter than 32 characters/,
  );
  const missing = openFirestoreStore({ client: null, projectId: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /Firestore project id is unset/);
});

test('firestore free grants deduct once and stop at the IP cap', async () => {
  const { store } = openMem();
  try {
    const first = walletId();
    const started = await store.beginSummarize(first, '203.0.113.9');
    assert.equal(started.balance, FREE_CREDITS - 1);
    assert.equal(await store.balanceOf(first), FREE_CREDITS - 1);
    const preview = await store.preview(first, '203.0.113.9');
    assert.equal(preview.exists, true);
    assert.equal(preview.balance, FREE_CREDITS - 1);

    for (let i = 1; i < FREE_WALLETS_PER_IP; i += 1) {
      const next = await store.beginSummarize(walletId(), '203.0.113.9');
      assert.equal(next.error, undefined);
    }
    const blocked = await store.beginSummarize(walletId(), '203.0.113.9');
    assert.equal(blocked.error, 'no_credits');
    assert.equal(blocked.balance, 0);
    const otherIp = await store.beginSummarize(walletId(), '203.0.113.10');
    assert.equal(otherIp.balance, FREE_CREDITS - 1);
  } finally {
    await store.close();
  }
});

test('firestore claims are exactly once, including a parallel grant', async () => {
  const { client, store } = openMem();
  try {
    const input = purchase('once');
    const [a, b] = await Promise.all([store.grantCredits(input), store.grantCredits({ ...input })]);
    const added = [a, b].map((row) => row.creditsAdded).sort((x, y) => y - x);
    assert.deepEqual(added, [5, 0]);
    assert.equal([a, b].filter((row) => row.alreadyClaimed).length, 1);
    assert.equal(await store.balanceOf(input.walletId), 5);
    const again = await store.grantCredits(input);
    assert.equal(again.alreadyClaimed, true);
    assert.equal(again.creditsAdded, 0);
    assert.equal(again.balance, 5);
    const index = await client.get(`claimsByWallet/${input.walletId}`);
    assert.deepEqual(index.session_ids, [input.sessionId]);
  } finally {
    await store.close();
  }
});

test('firestore refunds and disputes stay atomic across claim order', async () => {
  const { store } = openMem();
  try {
    const early = purchase('early');
    const pending = await store.applyRefund({
      chargeId: early.chargeId,
      paymentIntentId: early.paymentIntentId,
      amountRefunded: 99,
      chargeAmount: 99,
    });
    assert.equal(pending.pending, true);
    const claimed = await store.grantCredits(early);
    assert.equal(claimed.alreadyClaimed, false);
    assert.equal(claimed.creditsAdded, 0);
    assert.equal(claimed.balance, 0);

    const disputed = purchase('dispute');
    const granted = await store.grantCredits(disputed);
    assert.equal(granted.balance, 5);
    const opened = await store.applyDispute({
      chargeId: disputed.chargeId,
      paymentIntentId: disputed.paymentIntentId,
      amount: 99,
      status: 'needs_response',
      eventType: 'charge.dispute.created',
    });
    assert.equal(opened.deducted, 5);
    assert.equal(opened.balance, 0);
    const won = await store.applyDispute({
      chargeId: disputed.chargeId,
      paymentIntentId: disputed.paymentIntentId,
      amount: 99,
      status: 'won',
      eventType: 'charge.dispute.closed',
    });
    assert.equal(won.restored, 5);
    assert.equal(won.balance, 5);
    const refunded = await store.applyRefund({
      chargeId: disputed.chargeId,
      paymentIntentId: disputed.paymentIntentId,
      amountRefunded: 99,
      chargeAmount: 99,
    });
    assert.equal(refunded.deducted, 5);
    assert.equal(refunded.balance, 0);

    const warned = purchase('warn');
    await store.grantCredits(warned);
    const warning = await store.applyDispute({
      chargeId: warned.chargeId,
      paymentIntentId: warned.paymentIntentId,
      amount: 99,
      status: 'warning_needs_response',
      eventType: 'charge.dispute.created',
    });
    assert.equal(warning.deducted, 0);
    assert.equal(warning.balance, 5);
    const closed = await store.applyDispute({
      chargeId: warned.chargeId,
      paymentIntentId: warned.paymentIntentId,
      amount: 99,
      status: 'warning_closed',
      eventType: 'charge.dispute.closed',
    });
    assert.equal(closed.restored, 0);
    assert.equal(closed.balance, 5);

    const replayed = purchase('replay');
    await store.grantCredits(replayed);
    await store.applyDispute({
      chargeId: replayed.chargeId,
      paymentIntentId: replayed.paymentIntentId,
      amount: 99,
      status: 'needs_response',
      eventType: 'charge.dispute.created',
    });
    const restored = await store.applyDispute({
      chargeId: replayed.chargeId,
      paymentIntentId: replayed.paymentIntentId,
      amount: 99,
      status: 'warning_closed',
      eventType: 'charge.dispute.closed',
    });
    assert.equal(restored.balance, 5);
    const replay = await store.applyDispute({
      chargeId: replayed.chargeId,
      paymentIntentId: replayed.paymentIntentId,
      amount: 99,
      status: 'needs_response',
      eventType: 'charge.dispute.created',
    });
    assert.equal(replay.deducted, 0);
    assert.equal(replay.balance, 5);
  } finally {
    await store.close();
  }
});

test('firestore prune keeps a young claim, drops idle wallets, and tombstones old claims', async () => {
  const { client, store } = openMem();
  try {
    const fresh = purchase('fresh');
    await store.grantCredits(fresh);
    const freshWallet = await client.get(`wallets/${fresh.walletId}`);
    await client.set(`wallets/${fresh.walletId}`, {
      ...freshWallet,
      balance: 0,
      last_activity_at: ago(PAID_WALLET_IDLE_MS + 24 * 60 * 60 * 1000),
    });

    const stale = purchase('stale');
    await store.grantCredits(stale);
    const staleWallet = await client.get(`wallets/${stale.walletId}`);
    const staleClaim = await client.get(`claims/${stale.sessionId}`);
    await client.set(`wallets/${stale.walletId}`, {
      ...staleWallet,
      balance: 0,
      last_activity_at: ago(PAID_WALLET_IDLE_MS + 24 * 60 * 60 * 1000),
    });
    await client.set(`claims/${stale.sessionId}`, {
      ...staleClaim,
      created_at: ago(FREE_WALLET_IDLE_MS + 24 * 60 * 60 * 1000),
    });

    const freeId = walletId();
    await store.beginSummarize(freeId, '198.51.100.20');
    const freeWallet = await client.get(`wallets/${freeId}`);
    await client.set(`wallets/${freeId}`, {
      ...freeWallet,
      last_activity_at: ago(FREE_WALLET_IDLE_MS + 24 * 60 * 60 * 1000),
    });

    const ancient = purchase('ancient');
    await store.grantCredits(ancient);
    const ancientClaim = await client.get(`claims/${ancient.sessionId}`);
    await client.set(`claims/${ancient.sessionId}`, {
      ...ancientClaim,
      created_at: ago(CLAIM_RETENTION_MS + 24 * 60 * 60 * 1000),
    });

    await store.pruneNow();

    assert.equal((await store.preview(fresh.walletId, '198.51.100.21')).exists, true);
    assert.equal((await store.preview(stale.walletId, '198.51.100.21')).exists, false);
    assert.equal((await client.get(`claims/${stale.sessionId}`)).session_id, stale.sessionId);
    assert.equal((await store.preview(freeId, '198.51.100.20')).exists, false);
    const tomb = await client.get(`tombstones/${ancient.sessionId}`);
    assert.equal(tomb.claimed, 1);
    assert.equal(await client.get(`claims/${ancient.sessionId}`), null);
    const replay = await store.grantCredits(ancient);
    assert.equal(replay.tombstone, true);
    assert.equal(replay.creditsAdded, 0);
    assert.equal(replay.alreadyClaimed, true);
  } finally {
    await store.close();
  }
});

test('the HTTP API can use an injected Firestore store', async () => {
  const { store } = openMem();
  const wallet = walletId();
  const sessionId = 'cs_test_httpclaim';
  const app = createApp({
    store,
    prices: { price_starter: 5, price_pro: 50 },
    priceIds: { SMALL: 'price_starter', LARGE: 'price_pro' },
    amounts: { SMALL: 99, LARGE: 399 },
    webhookSecret: 'whsec_test',
    ipHashSecret: secret,
    summariesConfigured: true,
    trustCloudflare: false,
    stripe: {
      checkout: { sessions: { async retrieve(id) {
        assert.equal(id, sessionId);
        return {
          id,
          payment_status: 'paid',
          currency: 'eur',
          amount_total: 99,
          client_reference_id: wallet,
          metadata: { walletId: wallet, pack: 'SMALL' },
          payment_intent: { id: 'pi_http', latest_charge: { id: 'ch_http' } },
          line_items: { data: [{ quantity: 1, price: { id: 'price_starter', currency: 'eur', unit_amount: 99 } }] },
        };
      } } },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const claim = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wallet-id': wallet },
      body: JSON.stringify({ walletId: wallet, session_id: sessionId }),
    });
    assert.equal(claim.status, 200);
    const claimed = await claim.json();
    assert.equal(claimed.creditsAdded, 5);
    assert.equal(claimed.balance, 5);
    const read = await fetch(`${base}/api/wallet`, { headers: { 'x-wallet-id': wallet } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.match(read.headers.get('vary'), /X-Wallet-Id/);
    assert.equal((await read.json()).balance, 5);
  } finally {
    app.closeStore();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('Cloud Run docs select Firestore and the client stays off the sqlite path', () => {
  const deploy = fs.readFileSync(path.resolve('DEPLOY.md'), 'utf8');
  assert.ok(deploy.includes('STORE=firestore'));
  assert.ok(deploy.includes('roles/datastore.user'));
  assert.ok(deploy.includes('gcloud run deploy'));
  assert.ok(deploy.includes('--max-instances'));
  assert.ok(deploy.includes('GEMINI_API_KEY=GEMINI_API_KEY:latest'));
  assert.ok(deploy.includes('STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest'));
  assert.ok(deploy.includes('STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest'));
  assert.ok(deploy.includes('IP_HASH_SECRET=IP_HASH_SECRET:latest'));
  assert.ok(deploy.includes('ORIGIN_SECRET=ORIGIN_SECRET:latest'));
  assert.ok(deploy.includes('gen-lang-client-0860349793'));
  assert.ok(deploy.includes('us-west1'));
  assert.ok(deploy.includes('speedreader-pro'));
  assert.ok(deploy.includes('https://speedreader.nl/api/stripe-webhook'));
  assert.ok(deploy.includes('Set, not Add'));
  assert.equal(deploy.includes('DIRECT_CLOUDFLARE_ORIGIN=1` on Cloud Run') || deploy.includes('Do not set `DIRECT_CLOUDFLARE_ORIGIN=1` on Cloud Run'), true);
  const http = fs.readFileSync(path.resolve('lib/http.js'), 'utf8');
  const store = fs.readFileSync(path.resolve('lib/firestore-store.js'), 'utf8');
  assert.equal(http.includes('@google-cloud/firestore'), false);
  assert.equal(http.includes("replace(/\\/{2,}/g, '/')"), true);
  assert.ok(store.includes("require('@google-cloud/firestore')"));
  assert.ok(store.includes('preferRest: true'));
  const docker = fs.readFileSync(path.resolve('Dockerfile'), 'utf8');
  assert.ok(docker.includes('node:22-slim'));
  assert.ok(docker.includes('npm ci'));
  assert.ok(docker.includes('npm run build'));
  assert.ok(docker.includes('npm test'));
  assert.ok(docker.includes('npm prune --omit=dev'));
  assert.ok(docker.includes('NODE_ENV=production'));
  assert.ok(docker.includes('USER node'));
  assert.ok(docker.includes('CMD ["node","server.js"]'));
});
