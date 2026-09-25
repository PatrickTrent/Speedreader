import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Stripe from 'stripe';
import { summarizeWithGemini, SUMMARY_CHAR_LIMIT } from './lib/summarize.js';
import {
  createWalletStore,
  ensureWallet,
  grantCredits,
  isWalletId,
  refundCredit,
  reserveCredit,
  FREE_WALLETS_PER_IP_PER_DAY,
} from './lib/wallets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, 'dist');

const SUCCESS_URL = 'https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://speedreader.nl/';
const BODY_LIMIT = '512kb';
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.public = true;
  return err;
}

function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(ip).replace(/^::ffff:/, '');
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

function priceIdForPack(pack, priceIds) {
  if (pack === 'SMALL') return priceIds.SMALL || '';
  if (pack === 'LARGE') return priceIds.LARGE || '';
  return '';
}

function creditsForPrice(priceId, prices) {
  if (!priceId || !Object.prototype.hasOwnProperty.call(prices, priceId)) return null;
  return prices[priceId];
}

function lineItemPriceId(session) {
  const price = session.line_items?.data?.[0]?.price;
  if (!price) return '';
  return typeof price === 'string' ? price : price.id || '';
}

/** public/<slug>/index.html copied into dist by Vite. */
function intentPage(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean.includes('..')) return null;
  const slug = decodeURIComponent(clean.slice(1));
  if (!slug || slug.includes('/') || slug.includes('..')) return null;
  const file = path.resolve(distDir, slug, 'index.html');
  if (!file.startsWith(distDir + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

export function createApp(options = {}) {
  const dataDir = options.dataDir || path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const store = options.store || createWalletStore(dataDir);
  const summarize = options.summarize || ((text) => summarizeWithGemini(text));
  const now = options.now || (() => new Date());
  const freeWalletCap = options.freeWalletCap ?? FREE_WALLETS_PER_IP_PER_DAY;
  const priceIds = options.priceIds || {
    SMALL: process.env.STRIPE_PRICE_STARTER || '',
    LARGE: process.env.STRIPE_PRICE_PRO || '',
  };
  const prices = options.prices || {
    ...(priceIds.SMALL ? { [priceIds.SMALL]: 5 } : {}),
    ...(priceIds.LARGE ? { [priceIds.LARGE]: 50 } : {}),
  };
  const webhookSecret = options.webhookSecret !== undefined
    ? options.webhookSecret
    : process.env.STRIPE_WEBHOOK_SECRET || '';
  const allowSummarize = createRateLimiter(options.rateLimit || { windowMs: 10 * 60 * 1000, max: 20 });

  let stripe = options.stripe;
  if (stripe === undefined) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) stripe = null;
    else {
      try {
        stripe = new Stripe(key);
      } catch {
        console.error('stripe key rejected');
        stripe = null;
      }
    }
  }

  const app = express();
  if (process.env.TRUST_PROXY === '0') app.set('trust proxy', false);
  else app.set('trust proxy', 1);

  async function fulfill(sessionId, expectedWalletId) {
    if (!stripe) throw fail(503, 'stripe_unconfigured');
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId) || sessionId.length > 255) {
      throw fail(400, 'invalid_session');
    }
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items.data.price'],
      });
    } catch {
      throw fail(400, 'session_not_verified');
    }
    if (!session || session.payment_status !== 'paid') throw fail(400, 'payment_not_paid');
    const credits = creditsForPrice(lineItemPriceId(session), prices);
    if (!credits) throw fail(400, 'unknown_price');
    const walletId = session.client_reference_id || session.metadata?.walletId;
    if (!isWalletId(walletId)) throw fail(400, 'missing_wallet');
    if (expectedWalletId && expectedWalletId !== walletId) throw fail(403, 'wallet_mismatch');
    return store.update((data) => grantCredits(data, {
      sessionId: session.id,
      walletId,
      credits,
      at: now().toISOString(),
    }));
  }

  app.post(
    '/api/stripe-webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      if (!stripe || !webhookSecret) return res.status(503).json({ error: 'webhook_unconfigured' });
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
      } catch {
        return res.status(400).json({ error: 'invalid_signature' });
      }
      if (event.type !== 'checkout.session.completed') return res.json({ received: true });
      try {
        await fulfill(event.data?.object?.id);
        return res.json({ received: true });
      } catch (err) {
        if (err.message === 'payment_not_paid') return res.json({ received: true, credited: false });
        const status = err.status || 500;
        if (status >= 500) console.error('webhook failed');
        return res.status(status).json({ error: err.status ? err.message : 'webhook_failed' });
      }
    },
  );

  app.use(express.json({ limit: BODY_LIMIT }));

  app.post('/api/wallet', async (req, res) => {
    const walletId = req.body?.walletId;
    if (!isWalletId(walletId)) return res.status(400).json({ error: 'invalid_wallet' });
    try {
      const result = await store.update((data) => ensureWallet(data, walletId, clientIp(req), now(), freeWalletCap));
      return res.json({ walletId, balance: result.balance, created: result.created });
    } catch (err) {
      console.error('wallet store failed');
      return res.status(500).json({ error: 'store_failed' });
    }
  });

  app.post('/api/checkout', async (req, res) => {
    const walletId = req.body?.walletId;
    const pack = req.body?.pack;
    if (!isWalletId(walletId)) return res.status(400).json({ error: 'invalid_wallet' });
    if (pack !== 'SMALL' && pack !== 'LARGE') return res.status(400).json({ error: 'invalid_pack' });
    const priceId = priceIdForPack(pack, priceIds);
    if (!stripe || !priceId) return res.status(503).json({ error: 'checkout_unavailable' });
    try {
      const known = await store.update((data) => ({ exists: Boolean(data.wallets[walletId]) }));
      if (!known.exists) return res.status(404).json({ error: 'unknown_wallet' });
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: walletId,
        metadata: { walletId, pack },
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      });
      if (!session?.url) return res.status(502).json({ error: 'checkout_unavailable' });
      return res.json({ url: session.url });
    } catch (err) {
      console.error('checkout failed');
      return res.status(502).json({ error: 'checkout_unavailable' });
    }
  });

  app.post('/api/claim', async (req, res) => {
    const walletId = req.body?.walletId;
    if (!isWalletId(walletId)) return res.status(400).json({ error: 'invalid_wallet' });
    try {
      const result = await fulfill(req.body?.session_id, walletId);
      return res.json(result);
    } catch (err) {
      const status = err.public ? err.status : 500;
      if (status >= 500) console.error('claim failed');
      return res.status(status).json({ error: err.public ? err.message : 'claim_failed' });
    }
  });

  app.post('/api/summarize', async (req, res) => {
    if (!allowSummarize(clientIp(req))) return res.status(429).json({ error: 'rate_limited' });
    const walletId = req.body?.walletId;
    if (!isWalletId(walletId)) return res.status(400).json({ error: 'invalid_wallet' });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

    let reserved = false;
    try {
      const reservation = await store.update((data) => reserveCredit(data, walletId));
      if (reservation.error === 'unknown_wallet') return res.status(404).json({ error: 'unknown_wallet' });
      if (reservation.error === 'no_credits') {
        return res.status(402).json({ error: 'no_credits', balance: reservation.balance });
      }
      reserved = true;
      const summary = await summarize(text.slice(0, SUMMARY_CHAR_LIMIT));
      if (typeof summary !== 'string' || !summary.trim()) throw fail(502, 'summary_failed');
      const balance = await store.update((data) => ({ balance: data.wallets[walletId]?.balance ?? 0 }));
      return res.json({ summary: summary.toUpperCase(), balance: balance.balance });
    } catch (err) {
      let balance;
      if (reserved) {
        try {
          const refunded = await store.update((data) => refundCredit(data, walletId));
          balance = refunded.balance;
        } catch {
          balance = undefined;
        }
      }
      const status = err.public ? err.status : 502;
      if (status >= 500) console.error('summarize failed');
      return res.status(status).json({
        error: err.public ? err.message : 'summary_failed',
        ...(typeof balance === 'number' ? { balance } : {}),
      });
    }
  });

  // Intent HTML and the legacy redirect, before static files and the app fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const clean = req.path.replace(/\/+$/, '') || '/';
    if (clean === '/rsvp-reading') return res.redirect(301, '/rsvp');
    const file = intentPage(req.path);
    if (file) return res.sendFile(file);
    return next();
  });

  // App shell only. /#reader and /#faq are hashes on this document, not paths.
  app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  app.use(express.static(distDir, { index: false, redirect: false }));

  app.use((req, res) => {
    res
      .status(404)
      .type('html')
      .send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Not found</title>
</head>
<body>
<p>Not found.</p>
</body>
</html>
`);
  });

  return app;
}

function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html is missing. Run npm run build before npm start.');
    process.exit(1);
  }
  const app = createApp();
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Speedreader listening on ${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
