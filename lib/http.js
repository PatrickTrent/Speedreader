import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { applyCompanyMarkup } from './company.js';
import { isCloudflareAddress } from './cloudflare-ips.js';
import { isGoogleFrontendAddress, isLoopbackAddress } from './google-frontend-ips.js';
import { summarizeWithGemini, SUMMARY_CHAR_LIMIT, SUMMARY_TIMEOUT_MS, SUMMARY_UNAVAILABLE } from './summarize.js';
import {
  groupIp,
  isProductionEnv,
  isWalletId,
  normalizeWalletId,
  openWalletStore,
  productionConfigError,
  SESSION_MAX_AGE_MS,
  walletLogRef,
} from './wallets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

const SUCCESS_URL = 'https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://speedreader.nl/';
const BODY_LIMIT = '512kb';
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;
const PAYMENT_UNAVAILABLE = 'Payment is temporarily unavailable, you have not been charged';
const WALLET_MISMATCH = 'These credits were added to the browser that started the payment. Open that browser, or email speedreader@agentmail.to with your Stripe receipt.';
const INSTANT_PAYMENT_METHODS = ['card', 'ideal', 'bancontact'];
export const CONFIG_RATE_MAX = 600;

let sharedPeerWarned = false;

export { productionConfigError, PAYMENT_UNAVAILABLE, SUMMARY_UNAVAILABLE, WALLET_MISMATCH };

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.public = true;
  return err;
}

function headerValue(req, name) {
  const header = req.headers[name];
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === 'string' ? raw.trim() : '';
}

function originSecretMatches(req, secret) {
  if (!secret) return false;
  const got = headerValue(req, 'x-origin-secret');
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Last X-Forwarded-For hop that is not itself a Cloudflare or Google Front End
 * address. Walking from the right skips trusted proxies closest to this process.
 */
export function lastUntrustedForwardedHop(header) {
  const parts = String(header || '').split(',').map((part) => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const hop = parts[i];
    if (isCloudflareAddress(hop) || isGoogleFrontendAddress(hop)) continue;
    const grouped = groupIp(hop);
    if (grouped) return grouped;
  }
  return null;
}

/**
 * CF-Connecting-IP: when ORIGIN_SECRET is set, only a matching X-Origin-Secret
 * trusts that header, whatever the peer is. When the secret is unset, only a
 * Cloudflare-range peer trusts it. TRUST_FORWARDED_FROM=google uses the last
 * untrusted X-Forwarded-For hop when the peer is a Google Front End address and
 * the origin secret matches. An invalid address falls back to the socket.
 */
export function clientAddress(req, trustCloudflare, originSecret = '', options = {}) {
  const rawSocket = req.socket?.remoteAddress || '';
  const socketGroup = groupIp(rawSocket) || rawSocket || 'missing-socket';
  const secretOk = originSecretMatches(req, originSecret);
  if (trustCloudflare) {
    const allowHeader = originSecret ? secretOk : isCloudflareAddress(rawSocket);
    if (allowHeader) {
      const header = headerValue(req, 'cf-connecting-ip').split(',')[0].trim();
      const grouped = header && groupIp(header);
      if (grouped) return grouped;
    }
  }
  const trustGoogle = options.trustForwardedFrom === 'google' && originSecret && secretOk && isGoogleFrontendAddress(rawSocket);
  if (trustGoogle) {
    const hop = lastUntrustedForwardedHop(headerValue(req, 'x-forwarded-for'));
    if (hop) return hop;
  }
  return socketGroup;
}

/** Shared Google/LB peers without an origin secret must not share one /api/config bucket. */
export function configLimitApplies(peer, { originSecret = '', nodeEnv } = {}) {
  if (!isProductionEnv(nodeEnv)) return true;
  if (originSecret) return true;
  if (isCloudflareAddress(peer) || isLoopbackAddress(peer)) return true;
  return false;
}

export function trustForwardedFromEnv(env = process.env) {
  return String(env.TRUST_FORWARDED_FROM || '').trim().toLowerCase() === 'google' ? 'google' : '';
}

function warnSharedPeerOnce(peer) {
  if (sharedPeerWarned) return;
  sharedPeerWarned = true;
  console.error(`UNTRUSTED PEER ${peer}. ORIGIN_SECRET is unset, so forwarded client IPs are ignored. This peer is not Cloudflare and not loopback. /api/config will not use a shared rate-limit bucket. Set ORIGIN_SECRET from a Cloudflare Transform Rule, or TRUST_FORWARDED_FROM=google together with ORIGIN_SECRET. See DEPLOY.md.`);
}

export function trustCloudflareFromEnv(env = process.env) {
  if (env.TRUST_CLOUDFLARE === '0') return false;
  if (env.TRUST_CLOUDFLARE === '1') return true;
  return isProductionEnv(env.NODE_ENV);
}

function createRateLimiter({ windowMs, max, pruneEveryMs = 60_000 }) {
  const hits = new Map();
  function prune(now = Date.now()) {
    for (const [key, stamps] of hits) {
      const recent = stamps.filter((stamp) => now - stamp < windowMs);
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
    }
  }
  const timer = setInterval(() => prune(), pruneEveryMs);
  timer.unref?.();
  return {
    allow(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    size: () => hits.size,
    stop() {
      clearInterval(timer);
    },
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

function lineItemPriceId(item) {
  const price = item?.price;
  if (!price) return '';
  return typeof price === 'string' ? price : price.id || '';
}

function paymentRefs(session) {
  const pi = session.payment_intent;
  const paymentIntentId = typeof pi === 'string' ? pi : pi?.id || null;
  let chargeId = null;
  if (pi && typeof pi === 'object') {
    const charge = pi.latest_charge;
    chargeId = typeof charge === 'string' ? charge : charge?.id || null;
  }
  return { paymentIntentId, chargeId };
}

/** public/<slug>/index.html copied into dist by Vite. */
function intentPage(pathname) {
  let clean;
  let slug;
  try {
    clean = pathname.replace(/\/+$/, '') || '/';
    if (clean === '/' || clean.includes('..')) return null;
    slug = decodeURIComponent(clean.slice(1));
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
  if (!slug || slug.includes('/') || slug.includes('..')) return null;
  const file = path.resolve(distDir, slug, 'index.html');
  if (!file.startsWith(distDir + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

export function createApp(options = {}) {
  const dataDir = options.dataDir || path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const now = options.now || (() => new Date());
  const priceIds = options.priceIds || {
    SMALL: process.env.STRIPE_PRICE_STARTER || '',
    LARGE: process.env.STRIPE_PRICE_PRO || '',
  };
  const prices = options.prices || {
    ...(priceIds.SMALL ? { [priceIds.SMALL]: 5 } : {}),
    ...(priceIds.LARGE ? { [priceIds.LARGE]: 50 } : {}),
  };
  const amounts = options.amounts || {
    SMALL: Number(process.env.STRIPE_AMOUNT_STARTER || 99),
    LARGE: Number(process.env.STRIPE_AMOUNT_PRO || 399),
  };
  const webhookSecret = options.webhookSecret !== undefined
    ? options.webhookSecret
    : process.env.STRIPE_WEBHOOK_SECRET || '';
  const trustCloudflare = options.trustCloudflare !== undefined
    ? options.trustCloudflare
    : trustCloudflareFromEnv();
  const summariesConfigured = options.summariesConfigured !== undefined
    ? options.summariesConfigured
    : Boolean(process.env.GEMINI_API_KEY);
  const summaryTimeoutMs = options.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const summarize = options.summarize || ((text, callOptions) => summarizeWithGemini(text, process.env.GEMINI_API_KEY, {
    ...callOptions,
    timeoutMs: summaryTimeoutMs,
  }));

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

  const limits = options.rateLimits || {};
  const originSecret = options.originSecret !== undefined
    ? options.originSecret
    : process.env.ORIGIN_SECRET || '';
  const trustForwardedFrom = options.trustForwardedFrom !== undefined
    ? options.trustForwardedFrom
    : trustForwardedFromEnv();

  const limiters = {
    config: createRateLimiter(limits.config || { windowMs: 60_000, max: CONFIG_RATE_MAX }),
    webhook: createRateLimiter(limits.webhook || { windowMs: 60_000, max: 1000 }),
    wallet: createRateLimiter(limits.wallet || { windowMs: 60_000, max: 60 }),
    summarize: createRateLimiter(limits.summarize || { windowMs: 10 * 60_000, max: 20 }),
    checkout: createRateLimiter(limits.checkout || { windowMs: 10 * 60_000, max: 10 }),
    claim: createRateLimiter(limits.claim || { windowMs: 10 * 60_000, max: 30 }),
  };

  let store = null;
  if (options.failDatabase) {
    console.error('WALLET DATABASE FAILED. Payments and summaries are disabled. Check DATA_DIR and the SQLite file.');
  } else if (options.store) {
    store = options.store;
  } else {
    const opened = openWalletStore(dataDir, {
      now,
      ipHashSecret: options.ipHashSecret || process.env.IP_HASH_SECRET,
      freeWalletCap: options.freeWalletCap,
    });
    if (!opened.ok) {
      console.error('WALLET DATABASE FAILED. Payments and summaries are disabled. Check DATA_DIR and the SQLite file.');
      console.error(opened.error?.message || 'unknown database error');
    } else {
      store = opened;
      if (opened.ephemeralSecret && isProductionEnv(nodeEnv)) {
        console.error('IP_HASH_SECRET is unset. Refusing free-grant tracking with an ephemeral salt in production.');
      } else if (opened.ephemeralSecret) {
        console.error('IP_HASH_SECRET is unset. Free-grant hashes reset when this process restarts.');
      }
    }
  }

  const dbOk = Boolean(store);
  const paymentsConfigured = Boolean(stripe && priceIds.SMALL && priceIds.LARGE);
  const paymentsEnabled = dbOk && paymentsConfigured;
  const summariesEnabled = dbOk && summariesConfigured;

  function peerInfo(req) {
    const rawSocket = req.socket?.remoteAddress || '';
    const shared = !configLimitApplies(rawSocket, { originSecret, nodeEnv });
    if (shared) warnSharedPeerOnce(rawSocket);
    return {
      address: clientAddress(req, trustCloudflare, originSecret, { trustForwardedFrom }),
      shared,
    };
  }

  function ipOf(req) {
    return peerInfo(req).address;
  }

  function walletFrom(value) {
    const id = normalizeWalletId(value);
    return isWalletId(id) ? id : '';
  }

  function limited(name, req, res) {
    const peer = peerInfo(req);
    if (name === 'config' && peer.shared) return false;
    if (limiters[name].allow(peer.address)) return false;
    res.status(429).json({ error: 'rate_limited' });
    return true;
  }

  function stripeResourceMissing(err) {
    if (!err) return false;
    if (err.code === 'resource_missing' || err.raw?.code === 'resource_missing') return true;
    const status = err.statusCode || err.status || err.raw?.statusCode;
    return status === 404;
  }

  function validatePaidSession(session) {
    if (!session || session.payment_status !== 'paid') throw fail(400, 'payment_not_paid');
    const items = session.line_items?.data || [];
    if (items.length !== 1) throw fail(400, 'invalid_session');
    const item = items[0];
    if (Number(item.quantity) !== 1) throw fail(400, 'invalid_session');
    const priceId = lineItemPriceId(item);
    const credits = creditsForPrice(priceId, prices);
    if (!credits) throw fail(400, 'unknown_price');
    const currency = String(session.currency || item.price?.currency || '').toLowerCase();
    if (currency !== 'eur') throw fail(400, 'invalid_session');
    const pack = priceId === priceIds.SMALL ? 'SMALL' : priceId === priceIds.LARGE ? 'LARGE' : null;
    const expected = pack ? amounts[pack] : null;
    const unit = item.price && typeof item.price === 'object' ? item.price.unit_amount : null;
    if (expected == null || session.amount_total !== expected) throw fail(400, 'invalid_session');
    if (unit != null && unit !== expected) throw fail(400, 'invalid_session');
    const walletId = normalizeWalletId(session.client_reference_id || session.metadata?.walletId);
    if (!isWalletId(walletId)) throw fail(400, 'missing_wallet');
    return {
      sessionId: session.id,
      walletId,
      credits,
      priceId,
      amountTotal: session.amount_total,
      currency,
      ...paymentRefs(session),
    };
  }

  async function fulfill(sessionId) {
    if (!stripe) throw fail(503, 'stripe_unconfigured');
    if (!dbOk) throw fail(503, 'store_unavailable');
    if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId) || sessionId.length > 255) {
      throw fail(400, 'invalid_session');
    }
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items.data.price', 'payment_intent.latest_charge'],
      });
    } catch (err) {
      if (stripeResourceMissing(err)) throw fail(400, 'session_not_found');
      const wrapped = fail(502, 'session_not_verified');
      wrapped.retryable = true;
      wrapped.cause = err;
      throw wrapped;
    }
    const createdSec = Number(session.created);
    if (Number.isFinite(createdSec) && createdSec > 0) {
      if (now().getTime() - createdSec * 1000 > SESSION_MAX_AGE_MS) {
        throw fail(400, 'session_expired');
      }
    }
    const paid = validatePaidSession(session);
    return store.grantCredits(paid);
  }

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const q = req.url.indexOf('?');
    const pathOnly = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? '' : req.url.slice(q + 1);
    try {
      decodeURIComponent(pathOnly);
    } catch (err) {
      if (err instanceof URIError) {
        res.status(400).json({ error: 'bad_request' });
        return;
      }
      next(err);
      return;
    }
    if (query) {
      try {
        decodeURIComponent(query);
      } catch (err) {
        if (err instanceof URIError) req.url = pathOnly;
        else {
          next(err);
          return;
        }
      }
    }
    next();
  });

  app.get('/api/config', (req, res) => {
    if (limited('config', req, res)) return undefined;
    return res.json({ payments: paymentsEnabled, summaries: summariesEnabled });
  });

  app.post(
    '/api/stripe-webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      if (limited('webhook', req, res)) return undefined;
      if (!stripe || !webhookSecret) return res.status(503).json({ error: 'webhook_unconfigured' });
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
      } catch {
        return res.status(400).json({ error: 'invalid_signature' });
      }
      const type = event.type;
      const disputeEvent = type === 'charge.dispute.created'
        || type === 'charge.dispute.funds_withdrawn'
        || type === 'charge.dispute.closed';
      if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
        try {
          if (!dbOk) {
            console.error(`webhook ${type}: database unavailable`);
            return res.status(503).json({ error: 'store_unavailable' });
          }
          await fulfill(event.data?.object?.id);
          return res.json({ received: true });
        } catch (err) {
          if (err.retryable || !(err.public && err.status && err.status < 500)) {
            console.error('webhook failed');
            return res.status(500).json({ error: 'webhook_failed' });
          }
          console.error(`webhook ignored ${type}: ${err.message}`);
          return res.json({ received: true, credited: false });
        }
      }
      if (type === 'charge.refunded' || disputeEvent) {
        if (!dbOk) {
          console.error(`webhook ${type}: database unavailable`);
          return res.status(503).json({ error: 'store_unavailable' });
        }
        const obj = event.data?.object || {};
        const chargeId = type === 'charge.refunded' ? obj.id : obj.charge;
        const paymentIntentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
        try {
          const result = type === 'charge.refunded'
            ? store.applyRefund({
              chargeId,
              paymentIntentId,
              amountRefunded: obj.amount_refunded,
              chargeAmount: obj.amount,
            })
            : store.applyDispute({
              chargeId,
              paymentIntentId,
              amount: obj.amount,
              status: obj.status,
              eventType: type,
            });
          if (result.deducted > 0 || result.restored > 0) {
            console.error(`credits adjusted wallet=${walletLogRef(result.walletId)} deducted=${result.deducted || 0} restored=${result.restored || 0} balance=${result.balance} event=${type}`);
          } else if (result.pending) {
            console.error(`payment adjustment stored before claim event=${type}`);
          }
          return res.json({ received: true });
        } catch {
          console.error('webhook reversal failed');
          return res.status(500).json({ error: 'webhook_failed' });
        }
      }
      return res.json({ received: true });
    },
  );

  app.use(express.json({ limit: BODY_LIMIT }));

  app.get('/api/wallet', (req, res) => {
    if (limited('wallet', req, res)) return undefined;
    const walletId = walletFrom(req.query.walletId);
    if (!walletId) return res.status(400).json({ error: 'invalid_wallet' });
    if (!dbOk) return res.status(503).json({ error: 'store_unavailable', balance: 0, exists: false, freeEligible: false });
    try {
      const result = store.preview(walletId, ipOf(req));
      return res.json({ walletId, ...result });
    } catch {
      console.error('wallet read failed');
      return res.status(500).json({ error: 'store_failed' });
    }
  });

  app.post('/api/checkout', async (req, res) => {
    if (limited('checkout', req, res)) return undefined;
    const walletId = walletFrom(req.body?.walletId);
    const pack = req.body?.pack;
    if (!walletId) return res.status(400).json({ error: 'invalid_wallet' });
    if (pack !== 'SMALL' && pack !== 'LARGE') return res.status(400).json({ error: 'invalid_pack' });
    if (!paymentsEnabled) {
      return res.status(503).json({ error: 'checkout_unavailable', message: PAYMENT_UNAVAILABLE });
    }
    const priceId = priceIdForPack(pack, priceIds);
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: INSTANT_PAYMENT_METHODS,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: walletId,
        metadata: { walletId, pack },
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      });
      if (!session?.url) {
        return res.status(502).json({ error: 'checkout_unavailable', message: PAYMENT_UNAVAILABLE });
      }
      return res.json({ url: session.url });
    } catch {
      console.error('checkout failed');
      return res.status(502).json({ error: 'checkout_unavailable', message: PAYMENT_UNAVAILABLE });
    }
  });

  app.post('/api/claim', async (req, res) => {
    if (limited('claim', req, res)) return undefined;
    const walletId = walletFrom(req.body?.walletId);
    if (!walletId) return res.status(400).json({ error: 'invalid_wallet' });
    try {
      const result = await fulfill(req.body?.session_id);
      if (result.walletId !== walletId) {
        return res.status(403).json({ error: 'wallet_mismatch', message: WALLET_MISMATCH });
      }
      return res.json(result);
    } catch (err) {
      const status = err.public ? err.status : 500;
      if (status >= 500) console.error('claim failed');
      const body = { error: err.public ? err.message : 'claim_failed' };
      if (err.public && err.message === 'checkout_unavailable') body.message = PAYMENT_UNAVAILABLE;
      return res.status(status).json(body);
    }
  });

  app.post('/api/summarize', async (req, res) => {
    if (limited('summarize', req, res)) return undefined;
    if (!summariesEnabled) {
      return res.status(503).json({ error: 'summaries_unavailable', message: SUMMARY_UNAVAILABLE });
    }
    const walletId = walletFrom(req.body?.walletId);
    if (!walletId) return res.status(400).json({ error: 'invalid_wallet' });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'empty_text' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), summaryTimeoutMs);
    let reserved = false;
    try {
      const reservation = store.beginSummarize(walletId, ipOf(req));
      if (reservation.error === 'no_credits') {
        return res.status(402).json({ error: 'no_credits', balance: reservation.balance });
      }
      reserved = true;
      const summary = await new Promise((resolve, reject) => {
        const onAbort = () => reject(fail(504, 'summary_timeout'));
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(summarize(text.slice(0, SUMMARY_CHAR_LIMIT), { signal: controller.signal }))
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', onAbort));
      });
      if (typeof summary !== 'string' || !summary.trim()) throw fail(502, 'summary_failed');
      return res.json({ summary: summary.toUpperCase(), balance: store.balanceOf(walletId) });
    } catch (err) {
      let balance;
      if (reserved) {
        try {
          balance = store.refundCredit(walletId).balance;
        } catch {
          balance = undefined;
        }
      }
      if (controller.signal.aborted || err.message === 'summary_timeout') {
        return res.status(504).json({
          error: 'summary_timeout',
          message: SUMMARY_UNAVAILABLE,
          ...(typeof balance === 'number' ? { balance } : {}),
        });
      }
      const status = err.public ? err.status : 502;
      if (status >= 500) console.error('summarize failed');
      const code = err.public ? err.message : 'summary_failed';
      return res.status(status).json({
        error: code,
        ...(code === 'summaries_unavailable' ? { message: SUMMARY_UNAVAILABLE } : {}),
        ...(typeof balance === 'number' ? { balance } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof URIError) return res.status(400).json({ error: 'bad_request' });
    console.error('request failed');
    const status = Number(err?.status || err?.statusCode) || 500;
    const code = status >= 400 && status < 600 ? status : 500;
    if (isProductionEnv(nodeEnv)) {
      return res.status(code).json({ error: 'server_error' });
    }
    return res.status(code).json({ error: 'server_error' });
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const clean = req.path.replace(/\/+$/, '') || '/';
    if (clean === '/rsvp-reading') return res.redirect(301, '/rsvp');
    const file = intentPage(req.path);
    if (file) return res.type('html').send(applyCompanyMarkup(fs.readFileSync(file, 'utf8')));
    return next();
  });

  app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  app.use(express.static(distDir, { index: false, redirect: false }));

  app.use((req, res) => {
    res.status(404).type('html').send(`<!DOCTYPE html>
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

  if (options.exposeInternals) {
    app.limiterSize = (name) => limiters[name].size();
    app.pruneNow = () => store?.pruneNow?.();
  }

  app.closeStore = () => {
    for (const limiter of Object.values(limiters)) limiter.stop();
    try { store?.close?.(); } catch { /* already closed */ }
  };

  return app;
}

function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist/index.html is missing. Run npm run build before npm start.');
    process.exit(1);
  }
  const configError = productionConfigError();
  if (configError) {
    console.error(`REFUSING TO START: ${configError}. DATA_DIR must be a persistent volume outside the deploy directory, and IP_HASH_SECRET must be set.`);
    process.exit(1);
  }
  if (!process.env.ORIGIN_SECRET) {
    console.error('ORIGIN_SECRET is unset. CF-Connecting-IP is trusted only when the TCP peer is in a Cloudflare range. A peer that is neither Cloudflare nor loopback (Cloud Run, App Engine, or a Google load balancer) will ignore forwarded client IPs, and /api/config will not apply a shared rate-limit bucket for that peer.');
  }
  if (process.env.TRUST_FORWARDED_FROM === 'google' && !process.env.ORIGIN_SECRET) {
    console.error('TRUST_FORWARDED_FROM=google is ignored because ORIGIN_SECRET is unset. Google Front End forwarding requires both.');
  }
  const app = createApp();
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Speedreader listening on ${port}`);
  });
}

export { main };
