import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bindCheckoutReturn, CHECKOUT_NAV_TIMEOUT_MS, runCheckout } from '../lib/checkout-guard.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a double click sends one checkout request and an error allows another', async () => {
  const gate = deferred();
  const lock = { busy: false };
  const busy = [];
  let calls = 0;
  const first = runCheckout(lock, {
    unavailable: 'Payment is temporarily unavailable, you have not been charged',
    setBusy(value) { busy.push(value); },
    setPayError() { throw new Error('success path should not set an error'); },
    scheduleTimeout() { return 0; },
    async request() {
      calls += 1;
      await gate.promise;
      return { ok: true };
    },
  });
  const second = runCheckout(lock, {
    unavailable: 'Payment is temporarily unavailable, you have not been charged',
    setBusy(value) { busy.push(value); },
    setPayError() {},
    async request() {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(calls, 1);
  assert.equal(lock.busy, true);
  assert.deepEqual(busy, [true]);

  const retry = { busy: false };
  const errors = [];
  const flags = [];
  let failures = 0;
  const failing = {
    unavailable: 'Payment is temporarily unavailable, you have not been charged',
    setBusy(value) { flags.push(value); },
    setPayError(message) { errors.push(message); },
    async request() {
      failures += 1;
      if (failures === 1) return { ok: false, message: 'down' };
      throw new Error('network');
    },
  };
  assert.equal(await runCheckout(retry, failing), false);
  assert.equal(retry.busy, false);
  assert.equal(await runCheckout(retry, failing), false);
  assert.equal(failures, 2);
  assert.equal(retry.busy, false);
  assert.deepEqual(errors, ['down', 'Payment is temporarily unavailable, you have not been charged']);
  assert.deepEqual(flags, [true, false, true, false]);
});

test('the checkout buttons stay disabled while startCheckout ignores a second click', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  const start = app.slice(app.indexOf('const startCheckout'), app.indexOf('useEffect(() =>', app.indexOf('const startCheckout')));
  assert.match(start, /if \(checkoutLock\.current\.busy\) return;/);
  assert.match(start, /setPendingPack\(null\)/);
  assert.match(start, /runCheckout\(checkoutLock\.current/);
  assert.match(start, /fetch\('\/api\/checkout'/);
  assert.match(app, /bindCheckoutReturn\(checkoutLock\.current, setCheckoutBusy, window\)/);
  assert.equal(app.includes('disabled={checkoutBusy}'), true);
  assert.ok(app.includes('checkoutBusy={checkoutBusy}'));
  const modal = app.slice(app.indexOf('const PaymentModal'), app.indexOf('export default function App'));
  assert.equal((modal.match(/disabled=\{checkoutBusy\}/g) || []).length, 2);
  const offer = app.slice(app.indexOf('id="summary-result"'), app.indexOf('<FaqAccordion />'));
  assert.match(offer, /disabled=\{checkoutBusy\}/);
  const home = fs.readFileSync(path.resolve('lib/http.js'), 'utf8');
  const route = home.slice(home.indexOf("app.get(['/', '/index.html']"), home.indexOf('app.use((req, res, next)', home.indexOf("app.get(['/', '/index.html']")));
  assert.equal(route.includes('no-store'), false);
});

function pageTarget() {
  const listeners = {};
  const docListeners = {};
  const target = {
    document: {
      visibilityState: 'visible',
      addEventListener(type, fn) { docListeners[type] = fn; },
      removeEventListener(type) { delete docListeners[type]; },
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
  };
  return { target, listeners, docListeners };
}

test('pageshow persisted releases the checkout lock and enables the buttons', () => {
  const { target, listeners } = pageTarget();
  const lock = { busy: true, redirecting: true, timer: null };
  const busy = [];
  bindCheckoutReturn(lock, (value) => busy.push(value), target);
  listeners.pageshow({ persisted: false });
  assert.equal(lock.busy, true);
  assert.deepEqual(busy, []);
  listeners.pageshow({ persisted: true });
  assert.equal(lock.busy, false);
  assert.equal(lock.redirecting, false);
  assert.deepEqual(busy, [false]);
});

test('becoming visible after a redirect releases the checkout lock', () => {
  const { target, docListeners } = pageTarget();
  const lock = { busy: true, redirecting: false, timer: null };
  const busy = [];
  bindCheckoutReturn(lock, (value) => busy.push(value), target);
  target.document.visibilityState = 'visible';
  docListeners.visibilitychange();
  assert.equal(lock.busy, true);
  lock.redirecting = true;
  target.document.visibilityState = 'hidden';
  docListeners.visibilitychange();
  assert.equal(lock.busy, true);
  target.document.visibilityState = 'visible';
  docListeners.visibilitychange();
  assert.equal(lock.busy, false);
  assert.equal(lock.redirecting, false);
  assert.deepEqual(busy, [false]);
});

test('the checkout lock releases after 10s when navigation has not happened', async () => {
  const lock = { busy: false };
  const busy = [];
  let scheduled;
  let scheduledMs;
  const started = runCheckout(lock, {
    unavailable: 'Payment is temporarily unavailable, you have not been charged',
    setBusy(value) { busy.push(value); },
    setPayError() { throw new Error('success path should not set an error'); },
    scheduleTimeout(fn, ms) {
      scheduled = fn;
      scheduledMs = ms;
      return 7;
    },
    async request() { return { ok: true }; },
  });
  assert.equal(await started, true);
  assert.equal(lock.busy, true);
  assert.equal(lock.redirecting, true);
  assert.equal(scheduledMs, CHECKOUT_NAV_TIMEOUT_MS);
  assert.equal(CHECKOUT_NAV_TIMEOUT_MS, 10_000);
  scheduled();
  assert.equal(lock.busy, false);
  assert.equal(lock.redirecting, false);
  assert.equal(lock.timer, null);
  assert.deepEqual(busy, [true, false]);
});
