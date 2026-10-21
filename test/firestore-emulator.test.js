import test from 'node:test';
import assert from 'node:assert/strict';
import { openFirestoreStore } from '../lib/firestore-store.js';
import { CLAIM_RETENTION_MS } from '../lib/wallets.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const skip = host ? false : 'FIRESTORE_EMULATOR_HOST is unset';

function walletId() {
  return crypto.randomUUID();
}

function openReal(now = () => new Date()) {
  const store = openFirestoreStore({
    projectId: 'demo-speedreader',
    ipHashSecret: 'emulator-salt',
    pruneIntervalMs: 24 * 60 * 60 * 1000,
    now,
  });
  assert.equal(store.ok, true);
  return store;
}

test('emulator parallel decrements cannot overspend a small balance', { skip }, async () => {
  const store = openReal();
  try {
    await store.probe();
    const id = walletId();
    const granted = await store.grantCredits({
      walletId: id,
      sessionId: `cs_emu_dec_${id}`,
      credits: 5,
      amountTotal: 99,
      currency: 'eur',
      priceId: 'price_starter',
      chargeId: `ch_dec_${id}`,
      paymentIntentId: `pi_dec_${id}`,
    });
    assert.equal(granted.balance, 5);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.beginSummarize(id, '203.0.113.50')));
    const spent = results.filter((row) => !row.error);
    assert.equal(spent.length, 5);
    assert.equal(results.filter((row) => row.error === 'no_credits').length, 15);
    assert.equal(await store.balanceOf(id), 0);
    assert.equal(results.some((row) => row.balance < 0), false);
  } finally {
    await store.close();
  }
});

test('emulator claim from several wallets credits the session once', { skip }, async () => {
  const store = openReal();
  try {
    const sessionId = `cs_emu_claim_${crypto.randomUUID()}`;
    const wallets = Array.from({ length: 8 }, () => walletId());
    const results = await Promise.all(wallets.map((id) => store.grantCredits({
      walletId: id,
      sessionId,
      credits: 5,
      amountTotal: 99,
      currency: 'eur',
      priceId: 'price_starter',
      chargeId: `ch_${sessionId}`,
      paymentIntentId: `pi_${sessionId}`,
    })));
    assert.equal(results.filter((row) => row.creditsAdded === 5).length, 1);
    assert.equal(results.filter((row) => row.alreadyClaimed).length, 7);
    const balances = await Promise.all(wallets.map((id) => store.balanceOf(id)));
    assert.equal(balances.reduce((sum, value) => sum + value, 0), 5);
  } finally {
    await store.close();
  }
});

test('emulator grant races a full refund and a full dispute down to zero', { skip }, async () => {
  const store = openReal();
  try {
    for (let i = 0; i < 5; i += 1) {
      const id = walletId();
      const sessionId = `cs_emu_refund_${id}`;
      const chargeId = `ch_refund_${id}`;
      const paymentIntentId = `pi_refund_${id}`;
      const purchase = {
        walletId: id,
        sessionId,
        credits: 5,
        amountTotal: 99,
        currency: 'eur',
        priceId: 'price_starter',
        chargeId,
        paymentIntentId,
      };
      await Promise.all([
        store.grantCredits(purchase),
        store.applyRefund({ chargeId, paymentIntentId, amountRefunded: 99, chargeAmount: 99 }),
      ]);
      assert.equal(await store.balanceOf(id), 0, `refund race ${i}`);
    }
    for (let i = 0; i < 5; i += 1) {
      const id = walletId();
      const sessionId = `cs_emu_dispute_${id}`;
      const chargeId = `ch_dispute_${id}`;
      const paymentIntentId = `pi_dispute_${id}`;
      await Promise.all([
        store.grantCredits({
          walletId: id,
          sessionId,
          credits: 5,
          amountTotal: 99,
          currency: 'eur',
          priceId: 'price_starter',
          chargeId,
          paymentIntentId,
        }),
        store.applyDispute({
          chargeId,
          paymentIntentId,
          amount: 99,
          status: 'needs_response',
          eventType: 'charge.dispute.created',
        }),
      ]);
      assert.equal(await store.balanceOf(id), 0, `dispute race ${i}`);
    }
  } finally {
    await store.close();
  }
});

test('emulator prune replaces an old claim with a tombstone', { skip }, async () => {
  let nowMs = Date.now();
  const store = openReal(() => new Date(nowMs));
  try {
    const id = walletId();
    const sessionId = `cs_emu_tomb_${id}`;
    const granted = await store.grantCredits({
      walletId: id,
      sessionId,
      credits: 5,
      amountTotal: 99,
      currency: 'eur',
      priceId: 'price_starter',
      chargeId: `ch_tomb_${id}`,
      paymentIntentId: `pi_tomb_${id}`,
    });
    assert.equal(granted.creditsAdded, 5);
    nowMs += CLAIM_RETENTION_MS + 24 * 60 * 60 * 1000;
    await store.pruneNow();
    const replay = await store.grantCredits({
      walletId: id,
      sessionId,
      credits: 5,
      amountTotal: 99,
      currency: 'eur',
      priceId: 'price_starter',
      chargeId: `ch_tomb_${id}`,
      paymentIntentId: `pi_tomb_${id}`,
    });
    assert.equal(replay.tombstone, true);
    assert.equal(replay.creditsAdded, 0);
    assert.equal(replay.alreadyClaimed, true);
  } finally {
    await store.close();
  }
});
