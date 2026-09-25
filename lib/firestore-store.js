import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import {
  CLAIM_RETENTION_MS,
  FREE_CREDITS,
  FREE_GRANT_TTL_MS,
  FREE_WALLET_IDLE_MS,
  FREE_WALLETS_PER_IP,
  PAID_WALLET_IDLE_MS,
  PRUNE_INTERVAL_MS,
  creditsToRemove,
  disputeEffect,
  hashIp,
  isCloudRunEnv,
  normalizeWalletId,
} from './wallets.js';

const require = createRequire(import.meta.url);

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function docId(value) {
  const id = String(value || '');
  if (!id || id.includes('/')) throw new Error('invalid firestore id');
  return id;
}

function adaptFirestore(db) {
  return {
    runTransaction(fn) {
      return db.runTransaction(async (tx) => {
        const writes = [];
        const api = {
          async get(path) {
            const snap = await tx.get(db.doc(path));
            return snap.exists ? snap.data() : null;
          },
          set(path, data) {
            writes.push(['set', path, clone(data)]);
          },
          delete(path) {
            writes.push(['del', path]);
          },
        };
        const result = await fn(api);
        for (const write of writes) {
          if (write[0] === 'set') tx.set(db.doc(write[1]), write[2]);
          else tx.delete(db.doc(write[1]));
        }
        return result;
      });
    },
    async query(collection, field, op, value) {
      let q = db.collection(collection);
      if (field) q = q.where(field, op, value);
      const snap = await q.get();
      return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    },
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? snap.data() : null;
    },
    terminate() {
      return db.terminate?.();
    },
  };
}

function loadFirestoreClient({ projectId, databaseId }) {
  const { Firestore } = require('@google-cloud/firestore');
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const settings = {
    projectId,
    databaseId: databaseId || '(default)',
    preferRest: true,
  };
  // The emulator speaks gRPC and does not issue credentials. preferRest still
  // asks Application Default Credentials and rejects outside the caller's promise.
  if (emulator) settings.preferRest = false;
  return new Firestore(settings);
}

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function firestoreProjectFromEnv(env = process.env) {
  return String(env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '').trim();
}

/**
 * FIRESTORE_PROJECT wins. Cloud Run does not set GOOGLE_CLOUD_PROJECT, so when
 * that explicit value is missing and K_SERVICE or CLOUD_RUN_* is set, ask the
 * metadata server once. A missing or invalid answer is an empty string.
 */
export async function resolveFirestoreProject(env = process.env, fetchImpl = globalThis.fetch) {
  const fromEnv = firestoreProjectFromEnv(env);
  if (fromEnv) return fromEnv;
  if (!isCloudRunEnv(env)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  timer.unref?.();
  try {
    const res = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    if (!res?.ok) return '';
    const text = String(await res.text()).trim();
    return PROJECT_ID_RE.test(text) ? text : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export function openFirestoreStore(options = {}) {
  const projectId = String(options.projectId || firestoreProjectFromEnv() || '').trim();
  const databaseId = String(options.databaseId || process.env.FIRESTORE_DATABASE || '(default)').trim() || '(default)';
  let backend = options.client;
  if (!backend) {
    if (!projectId) return { ok: false, error: new Error('Firestore project id is unset') };
    try {
      backend = adaptFirestore(loadFirestoreClient({ projectId, databaseId }));
    } catch (err) {
      return { ok: false, error: err };
    }
  }
  try {
    return buildStore(backend, options, { projectId, databaseId });
  } catch (err) {
    return { ok: false, error: err };
  }
}

function buildStore(db, options, meta) {
  const now = options.now || (() => new Date());
  const cap = options.freeWalletCap ?? FREE_WALLETS_PER_IP;
  const secret = options.ipHashSecret || randomBytes(32).toString('hex');

  function iso(date) {
    return date.toISOString();
  }

  function cutoff(ms) {
    return iso(new Date(now().getTime() - ms));
  }

  function walletPath(id) {
    return `wallets/${docId(id)}`;
  }

  function claimPath(sessionId) {
    return `claims/${docId(sessionId)}`;
  }

  async function grantCount(tx, ip) {
    const hash = hashIp(ip, secret);
    if (!hash) return cap;
    const row = await tx.get(`freeGrants/${hash}`);
    const times = Array.isArray(row?.times) ? row.times.filter((stamp) => stamp >= cutoff(FREE_GRANT_TTL_MS)) : [];
    return times.length;
  }

  async function findClaimByRefs(tx, chargeId, paymentIntentId) {
    if (chargeId) {
      const ref = await tx.get(`claimByCharge/${docId(chargeId)}`);
      if (ref?.session_id) {
        const claim = await tx.get(claimPath(ref.session_id));
        if (claim) return claim;
      }
    }
    if (paymentIntentId) {
      const ref = await tx.get(`claimByIntent/${docId(paymentIntentId)}`);
      if (ref?.session_id) return tx.get(claimPath(ref.session_id));
    }
    return null;
  }

  function adjustmentPaths(chargeId, paymentIntentId) {
    const paths = [];
    if (chargeId) paths.push(`adjustments/c_${docId(chargeId)}`);
    if (paymentIntentId) paths.push(`adjustments/i_${docId(paymentIntentId)}`);
    return paths;
  }

  async function findAdjustment(tx, chargeId, paymentIntentId) {
    for (const path of adjustmentPaths(chargeId, paymentIntentId)) {
      const row = await tx.get(path);
      if (row) return row;
    }
    return null;
  }

  function writeAdjustment(tx, data) {
    for (const path of adjustmentPaths(data.charge_id, data.payment_intent_id)) tx.set(path, data);
  }

  function deleteAdjustment(tx, data) {
    if (!data) return;
    for (const path of adjustmentPaths(data.charge_id, data.payment_intent_id)) tx.delete(path);
  }

  async function rememberAdjustment(tx, { chargeId, paymentIntentId, amountRefunded, chargeAmount, disputeAmount, disputeStatus }) {
    const existing = await findAdjustment(tx, chargeId, paymentIntentId);
    const ts = iso(now());
    const data = {
      charge_id: chargeId || existing?.charge_id || null,
      payment_intent_id: paymentIntentId || existing?.payment_intent_id || null,
      amount_refunded: amountRefunded != null ? amountRefunded : Number(existing?.amount_refunded || 0),
      charge_amount: chargeAmount != null ? chargeAmount : (existing?.charge_amount ?? null),
      dispute_amount: disputeAmount != null ? disputeAmount : Number(existing?.dispute_amount || 0),
      dispute_status: disputeStatus || existing?.dispute_status || null,
      updated_at: ts,
    };
    writeAdjustment(tx, data);
  }

  function writeClaimRefs(tx, claim) {
    if (claim.charge_id) tx.set(`claimByCharge/${docId(claim.charge_id)}`, { session_id: claim.session_id });
    if (claim.payment_intent_id) tx.set(`claimByIntent/${docId(claim.payment_intent_id)}`, { session_id: claim.session_id });
  }

  async function preview(walletId, ip) {
    return db.runTransaction(async (tx) => {
      const row = await tx.get(walletPath(normalizeWalletId(walletId)));
      if (row) return { exists: true, balance: row.balance, freeEligible: false };
      return { exists: false, balance: 0, freeEligible: (await grantCount(tx, ip)) < cap };
    });
  }

  async function beginSummarize(walletId, ip) {
    const id = normalizeWalletId(walletId);
    return db.runTransaction(async (tx) => {
      let row = await tx.get(walletPath(id));
      const hash = hashIp(ip, secret);
      const grantPath = hash ? `freeGrants/${hash}` : '';
      const grant = grantPath ? await tx.get(grantPath) : null;
      if (!row) {
        const recent = Array.isArray(grant?.times) ? grant.times.filter((stamp) => stamp >= cutoff(FREE_GRANT_TTL_MS)) : [];
        if (!hash || recent.length >= cap) return { error: 'no_credits', balance: 0 };
        const ts = iso(now());
        row = {
          id,
          balance: FREE_CREDITS,
          created_at: ts,
          last_activity_at: ts,
          free_grant: 1,
          has_payment: 0,
        };
        tx.set(walletPath(id), row);
        tx.set(grantPath, { times: [...recent, ts] });
      }
      if (row.balance < 1) return { error: 'no_credits', balance: row.balance };
      const ts = iso(now());
      row.balance -= 1;
      row.last_activity_at = ts;
      tx.set(walletPath(id), row);
      return { balance: row.balance, reserved: true };
    });
  }

  async function refundCredit(walletId) {
    const id = normalizeWalletId(walletId);
    return db.runTransaction(async (tx) => {
      const row = await tx.get(walletPath(id));
      if (!row) return { balance: 0 };
      row.balance += 1;
      row.last_activity_at = iso(now());
      tx.set(walletPath(id), row);
      return { balance: row.balance };
    });
  }

  async function balanceOf(walletId) {
    return db.runTransaction(async (tx) => {
      const row = await tx.get(walletPath(normalizeWalletId(walletId)));
      return row ? row.balance : 0;
    });
  }

  async function grantCredits(input) {
    const walletId = normalizeWalletId(input.walletId);
    return db.runTransaction(async (tx) => {
      const prior = await tx.get(claimPath(input.sessionId));
      const tomb = await tx.get(`tombstones/${docId(input.sessionId)}`);
      const ownWallet = await tx.get(walletPath(walletId));
      const priorWallet = prior && prior.wallet_id !== walletId ? await tx.get(walletPath(prior.wallet_id)) : ownWallet;
      const adj = await findAdjustment(tx, input.chargeId, input.paymentIntentId);
      const indexPath = `claimsByWallet/${docId(walletId)}`;
      const index = prior || tomb ? null : await tx.get(indexPath);
      if (prior) {
        return {
          alreadyClaimed: true,
          balance: priorWallet?.balance ?? 0,
          creditsAdded: 0,
          walletId: prior.wallet_id,
        };
      }
      if (tomb) {
        return {
          alreadyClaimed: true,
          balance: ownWallet?.balance ?? 0,
          creditsAdded: 0,
          walletId,
          tombstone: true,
        };
      }
      let amountRefunded = 0;
      let creditsRefunded = 0;
      let disputeAmount = 0;
      let disputeStatus = null;
      let creditsDisputed = 0;
      let disputeTaken = 0;
      if (adj) {
        amountRefunded = Number(adj.amount_refunded || 0);
        disputeAmount = Number(adj.dispute_amount || 0);
        disputeStatus = adj.dispute_status || null;
        creditsRefunded = creditsToRemove(input.credits, amountRefunded, input.amountTotal);
        if (disputeEffect(disputeStatus, 'charge.dispute.created') === 'deduct') {
          creditsDisputed = creditsToRemove(input.credits, disputeAmount, input.amountTotal);
        }
        if (creditsRefunded + creditsDisputed > input.credits) {
          creditsDisputed = Math.max(0, input.credits - creditsRefunded);
        }
        disputeTaken = creditsDisputed;
      }
      const net = Math.max(0, input.credits - creditsRefunded - creditsDisputed);
      const ts = iso(now());
      const wallet = ownWallet || {
        id: walletId,
        balance: 0,
        created_at: ts,
        last_activity_at: ts,
        free_grant: 0,
        has_payment: 1,
      };
      wallet.balance += net;
      wallet.has_payment = 1;
      wallet.last_activity_at = ts;
      const claim = {
        session_id: input.sessionId,
        wallet_id: walletId,
        credits: input.credits,
        price_id: input.priceId || null,
        amount_total: input.amountTotal ?? null,
        currency: input.currency || null,
        payment_intent_id: input.paymentIntentId || null,
        charge_id: input.chargeId || null,
        created_at: ts,
        reversed: 0,
        amount_refunded: amountRefunded,
        credits_refunded: creditsRefunded,
        dispute_amount: disputeAmount,
        dispute_status: disputeStatus,
        credits_disputed: creditsDisputed,
        credits_dispute_taken: disputeTaken,
      };
      tx.set(walletPath(walletId), wallet);
      tx.set(claimPath(input.sessionId), claim);
      writeClaimRefs(tx, claim);
      deleteAdjustment(tx, adj);
      const sessionIds = new Set(index?.session_ids || []);
      sessionIds.add(input.sessionId);
      tx.set(indexPath, { session_ids: [...sessionIds] });
      return {
        alreadyClaimed: false,
        balance: wallet.balance,
        creditsAdded: net,
        walletId,
      };
    });
  }

  function deductLocal(wallet, amount) {
    if (!wallet || amount <= 0) return 0;
    const before = Number(wallet.balance || 0);
    wallet.balance = Math.max(0, before - amount);
    wallet.last_activity_at = iso(now());
    return before - wallet.balance;
  }

  async function applyRefund({ chargeId, paymentIntentId, amountRefunded, chargeAmount }) {
    return db.runTransaction(async (tx) => {
      const claim = await findClaimByRefs(tx, chargeId, paymentIntentId);
      const refunded = Number.isFinite(Number(amountRefunded))
        ? Number(amountRefunded)
        : Number(chargeAmount || 0);
      if (!claim) {
        if (!chargeId && !paymentIntentId) return { found: false, pending: false };
        await rememberAdjustment(tx, {
          chargeId,
          paymentIntentId,
          amountRefunded: refunded,
          chargeAmount: chargeAmount ?? null,
        });
        return { found: false, pending: true, deducted: 0 };
      }
      const wallet = await tx.get(walletPath(claim.wallet_id));
      const total = claim.amount_total || chargeAmount;
      const already = Number(claim.credits_refunded || 0);
      const target = Math.max(already, creditsToRemove(claim.credits, refunded, total));
      const delta = target - already;
      const room = Math.max(0, claim.credits - already - Number(claim.credits_dispute_taken || 0));
      const applied = deductLocal(wallet, Math.min(delta, room));
      claim.amount_refunded = refunded;
      claim.credits_refunded = target;
      if (wallet) tx.set(walletPath(claim.wallet_id), wallet);
      tx.set(claimPath(claim.session_id), claim);
      return {
        found: true,
        pending: false,
        deducted: applied,
        alreadyApplied: applied === 0,
        balance: wallet?.balance ?? 0,
        walletId: claim.wallet_id,
      };
    });
  }

  async function applyDispute({ chargeId, paymentIntentId, amount, status, eventType }) {
    const effect = disputeEffect(status, eventType);
    const disputeStatus = String(status || '');
    return db.runTransaction(async (tx) => {
      const claim = await findClaimByRefs(tx, chargeId, paymentIntentId);
      if (!claim) {
        if (!chargeId && !paymentIntentId) return { found: false, pending: false };
        const existing = await findAdjustment(tx, chargeId, paymentIntentId);
        await rememberAdjustment(tx, {
          chargeId,
          paymentIntentId,
          amountRefunded: existing ? existing.amount_refunded : 0,
          chargeAmount: existing ? existing.charge_amount : null,
          disputeAmount: Number(amount || 0),
          disputeStatus,
        });
        return { found: false, pending: true, deducted: 0, restored: 0 };
      }
      const wallet = await tx.get(walletPath(claim.wallet_id));
      if (effect === 'restore') {
        const restore = Number(claim.credits_dispute_taken || 0);
        if (wallet && restore > 0) {
          wallet.balance += restore;
          wallet.last_activity_at = iso(now());
        }
        claim.dispute_amount = Number(amount || claim.dispute_amount || 0);
        claim.dispute_status = disputeStatus;
        claim.credits_dispute_taken = 0;
        if (wallet) tx.set(walletPath(claim.wallet_id), wallet);
        tx.set(claimPath(claim.session_id), claim);
        return {
          found: true,
          pending: false,
          restored: restore,
          deducted: 0,
          balance: wallet?.balance ?? 0,
          walletId: claim.wallet_id,
        };
      }
      if (effect !== 'deduct') {
        claim.dispute_amount = Number(amount || claim.dispute_amount || 0);
        claim.dispute_status = disputeStatus;
        tx.set(claimPath(claim.session_id), claim);
        return {
          found: true,
          pending: false,
          deducted: 0,
          restored: 0,
          alreadyApplied: true,
          balance: wallet?.balance ?? 0,
          walletId: claim.wallet_id,
        };
      }
      const total = claim.amount_total;
      const already = Number(claim.credits_disputed || 0);
      const target = Math.max(already, creditsToRemove(claim.credits, amount, total));
      const delta = target - already;
      const room = Math.max(0, claim.credits - Number(claim.credits_refunded || 0) - already);
      const applied = deductLocal(wallet, Math.min(delta, room));
      claim.dispute_amount = Number(amount || 0);
      claim.dispute_status = disputeStatus;
      claim.credits_disputed = target;
      claim.credits_dispute_taken = Number(claim.credits_dispute_taken || 0) + applied;
      if (wallet) tx.set(walletPath(claim.wallet_id), wallet);
      tx.set(claimPath(claim.session_id), claim);
      return {
        found: true,
        pending: false,
        deducted: applied,
        restored: 0,
        alreadyApplied: delta === 0,
        balance: wallet?.balance ?? 0,
        walletId: claim.wallet_id,
      };
    });
  }

  async function pruneGrants() {
    const rows = await db.query('freeGrants');
    const limit = cutoff(FREE_GRANT_TTL_MS);
    for (const row of rows) {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(`freeGrants/${docId(row.id)}`);
        if (!current) return;
        const times = (current.times || []).filter((stamp) => stamp >= limit);
        if (times.length === 0) tx.delete(`freeGrants/${docId(row.id)}`);
        else tx.set(`freeGrants/${docId(row.id)}`, { times });
      });
    }
  }

  async function pruneFreeWallets() {
    const limit = cutoff(FREE_WALLET_IDLE_MS);
    const rows = await db.query('wallets', 'last_activity_at', '<', limit);
    for (const row of rows) {
      await db.runTransaction(async (tx) => {
        const wallet = await tx.get(walletPath(row.id));
        if (!wallet || wallet.has_payment !== 0 || wallet.last_activity_at >= limit) return;
        const claims = await tx.get(`claimsByWallet/${docId(row.id)}`);
        if (claims?.session_ids?.length) return;
        tx.delete(walletPath(row.id));
      });
    }
  }

  async function prunePaidWallets() {
    const idle = cutoff(PAID_WALLET_IDLE_MS);
    const disputeWindow = cutoff(FREE_WALLET_IDLE_MS);
    const rows = await db.query('wallets', 'last_activity_at', '<', idle);
    for (const row of rows) {
      await db.runTransaction(async (tx) => {
        const wallet = await tx.get(walletPath(row.id));
        if (!wallet || wallet.has_payment !== 1 || wallet.balance !== 0 || wallet.last_activity_at >= idle) return;
        const index = await tx.get(`claimsByWallet/${docId(row.id)}`);
        const sessionIds = index?.session_ids || [];
        const claims = [];
        for (const sessionId of sessionIds) claims.push(await tx.get(claimPath(sessionId)));
        if (claims.some((claim) => claim && claim.created_at >= disputeWindow)) return;
        tx.delete(walletPath(row.id));
      });
    }
  }

  async function pruneClaims() {
    const limit = cutoff(CLAIM_RETENTION_MS);
    const rows = await db.query('claims', 'created_at', '<', limit);
    for (const row of rows) {
      await db.runTransaction(async (tx) => {
        const claim = await tx.get(claimPath(row.id));
        if (!claim || claim.created_at >= limit) return;
        const indexPath = `claimsByWallet/${docId(claim.wallet_id)}`;
        const index = await tx.get(indexPath);
        tx.set(`tombstones/${docId(claim.session_id)}`, { session_id: claim.session_id, claimed: 1 });
        tx.delete(claimPath(claim.session_id));
        if (claim.charge_id) tx.delete(`claimByCharge/${docId(claim.charge_id)}`);
        if (claim.payment_intent_id) tx.delete(`claimByIntent/${docId(claim.payment_intent_id)}`);
        if (index?.session_ids) {
          const sessionIds = index.session_ids.filter((id) => id !== claim.session_id);
          if (sessionIds.length === 0) tx.delete(indexPath);
          else tx.set(indexPath, { session_ids: sessionIds });
        }
      });
    }
    const adjustments = await db.query('adjustments', 'updated_at', '<', limit);
    for (const row of adjustments) {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(`adjustments/${docId(row.id)}`);
        if (current && current.updated_at < limit) tx.delete(`adjustments/${docId(row.id)}`);
      });
    }
  }

  async function pruneAll() {
    await pruneGrants();
    await pruneFreeWallets();
    await prunePaidWallets();
    await pruneClaims();
  }

  const pruneEvery = options.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
  const pruneTimer = setInterval(() => {
    pruneAll().catch((err) => {
      console.error('prune failed');
      console.error(err?.message || 'unknown prune error');
    });
  }, pruneEvery);
  pruneTimer.unref?.();

  function close() {
    clearInterval(pruneTimer);
    return db.terminate?.();
  }

  async function probe() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Firestore startup read timed out')), 10_000);
      timer.unref?.();
    });
    const read = (typeof db.get === 'function'
      ? Promise.resolve().then(() => db.get('meta/startup'))
      : db.runTransaction(async (tx) => tx.get('meta/startup'))
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    try {
      const result = await Promise.race([read, timeout]);
      if (result && result.ok === false) throw result.error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: true,
    kind: 'firestore',
    projectId: meta.projectId || null,
    databaseId: meta.databaseId || null,
    ephemeralSecret: !options.ipHashSecret,
    preview,
    beginSummarize,
    refundCredit,
    balanceOf,
    grantCredits,
    applyRefund,
    applyDispute,
    pruneNow: pruneAll,
    probe,
    close,
  };
}
