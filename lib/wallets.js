import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FREE_CREDITS = 2;
export const FREE_WALLETS_PER_IP = 5;
export const FREE_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
export const FREE_WALLET_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
export const CLAIM_RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;
export const PAID_WALLET_IDLE_MS = 3 * 365 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DISPUTE_RESTORE = new Set(['won', 'warning_closed']);
const DISPUTE_WARNING = new Set(['warning_needs_response', 'warning_under_review']);
const DISPUTE_REAL = new Set(['needs_response', 'under_review', 'lost', 'charge_refunded']);
const DISPUTE_OPEN_EVENTS = new Set(['charge.dispute.created', 'charge.dispute.funds_withdrawn']);

/** Short log token. Hosting logs must not contain the full wallet id. */
export function walletLogRef(walletId) {
  if (!walletId) return 'none';
  return createHash('sha256').update(String(walletId)).digest('hex').slice(0, 8);
}

/**
 * restore: give back credits actually removed (won, warning_closed).
 * deduct: a real dispute status on created or funds_withdrawn.
 * record: store the status and leave the balance alone.
 */
export function disputeEffect(status, eventType) {
  const normalized = String(status || '');
  if (DISPUTE_RESTORE.has(normalized)) return 'restore';
  if (DISPUTE_WARNING.has(normalized)) return 'record';
  if (DISPUTE_OPEN_EVENTS.has(eventType) && DISPUTE_REAL.has(normalized)) return 'deduct';
  return 'record';
}

const WALLET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeWalletId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isWalletId(value) {
  return WALLET_RE.test(normalizeWalletId(value));
}

/** Anything other than development or test is production, including an unset NODE_ENV. */
export function isProductionEnv(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

/** Credits removed for a cumulative refund. Idempotent when called with the same amount_refunded. */
export function creditsToRemove(creditsBought, amountRefunded, amountTotal) {
  const credits = Number(creditsBought);
  const refunded = Number(amountRefunded);
  const total = Number(amountTotal);
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  if (!Number.isFinite(refunded) || refunded <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(credits, Math.floor((credits * refunded) / total));
}

/** IPv4 as-is. IPv6 collapsed to its /64. Invalid input returns null, never a shared bucket. */
export function groupIp(ip) {
  if (!ip) return null;
  let clean = String(ip).trim();
  if (clean.startsWith('[')) {
    const end = clean.indexOf(']');
    if (end > 0) clean = clean.slice(1, end);
  }
  const v4WithPort = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) clean = v4WithPort[1];
  if (clean.endsWith('::/64')) {
    const network = clean.slice(0, -3);
    if (isIP(network) === 6) return clean;
  }
  if (clean.toLowerCase().startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (isIP(mapped) === 4) clean = mapped;
  }
  if (isIP(clean) === 4) return clean;
  if (isIP(clean) === 6) return `${ipv6Groups(clean).slice(0, 4).join(':')}::/64`;
  return null;
}

function ipv6Groups(ip) {
  const lower = ip.toLowerCase();
  const [head, tail] = lower.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail === undefined ? null : (tail ? tail.split(':').filter(Boolean) : []);
  let parts;
  if (tailParts === null) parts = headParts;
  else {
    const missing = 8 - headParts.length - tailParts.length;
    parts = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
  }
  while (parts.length < 8) parts.push('0');
  return parts.slice(0, 8).map((part) => part.padStart(4, '0'));
}

export function hashIp(ip, secret) {
  const grouped = groupIp(ip);
  if (!grouped) return null;
  return createHmac('sha256', String(secret)).update(grouped).digest('hex');
}

/**
 * Production must point DATA_DIR at a persistent volume outside the deploy
 * directory, and must set IP_HASH_SECRET. Returns an error string, or null.
 */
export function productionConfigError({
  nodeEnv = process.env.NODE_ENV,
  dataDir = process.env.DATA_DIR,
  ipHashSecret = process.env.IP_HASH_SECRET,
  appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  cwd = process.cwd(),
} = {}) {
  if (!isProductionEnv(nodeEnv)) return null;
  if (!dataDir) return 'DATA_DIR is unset';
  const resolved = path.resolve(dataDir);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const real = fs.realpathSync(resolved);
    for (const root of [path.resolve(appRoot), path.resolve(cwd)]) {
      let realRoot = root;
      try { realRoot = fs.realpathSync(root); } catch { /* missing root stays lexical */ }
      if (real === realRoot || real.startsWith(realRoot + path.sep)) {
        return `DATA_DIR (${real}) is inside the deploy directory (${realRoot})`;
      }
    }
  } catch {
    // Unwritable or not a directory. Startup continues; opening the store fails closed.
  }
  if (!ipHashSecret) return 'IP_HASH_SECRET is unset';
  return null;
}

function iso(date) {
  return date.toISOString();
}

export function openWalletStore(dataDir, options = {}) {
  let db;
  let file;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const realDir = fs.realpathSync(dataDir);
    file = path.join(realDir, 'wallets.sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL CHECK (balance >= 0),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        free_grant INTEGER NOT NULL DEFAULT 0,
        has_payment INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS claims (
        session_id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        credits INTEGER NOT NULL,
        price_id TEXT,
        amount_total INTEGER,
        currency TEXT,
        payment_intent_id TEXT,
        charge_id TEXT,
        created_at TEXT NOT NULL,
        reversed INTEGER NOT NULL DEFAULT 0,
        amount_refunded INTEGER NOT NULL DEFAULT 0,
        credits_refunded INTEGER NOT NULL DEFAULT 0,
        dispute_amount INTEGER NOT NULL DEFAULT 0,
        dispute_status TEXT,
        credits_disputed INTEGER NOT NULL DEFAULT 0,
        credits_dispute_taken INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_claims_pi ON claims(payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_claims_charge ON claims(charge_id);
      CREATE INDEX IF NOT EXISTS idx_wallets_activity ON wallets(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);
      CREATE TABLE IF NOT EXISTS adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        charge_id TEXT,
        payment_intent_id TEXT,
        amount_refunded INTEGER NOT NULL DEFAULT 0,
        charge_amount INTEGER,
        dispute_amount INTEGER NOT NULL DEFAULT 0,
        dispute_status TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_adj_charge ON adjustments(charge_id);
      CREATE INDEX IF NOT EXISTS idx_adj_pi ON adjustments(payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_adj_updated ON adjustments(updated_at);
      CREATE TABLE IF NOT EXISTS claim_tombstones (
        session_id TEXT PRIMARY KEY,
        claimed INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS free_grants (
        ip_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_free_grants_hash ON free_grants(ip_hash, created_at);
    `);
    for (const [name, ddl] of [
      ['amount_refunded', 'INTEGER NOT NULL DEFAULT 0'],
      ['credits_refunded', 'INTEGER NOT NULL DEFAULT 0'],
      ['dispute_amount', 'INTEGER NOT NULL DEFAULT 0'],
      ['dispute_status', 'TEXT'],
      ['credits_disputed', 'INTEGER NOT NULL DEFAULT 0'],
      ['credits_dispute_taken', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      const cols = db.prepare('PRAGMA table_info(claims)').all();
      if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${ddl}`);
    }
  } catch (err) {
    try { db?.close(); } catch { /* not open */ }
    return { ok: false, error: err, file };
  }

  const now = options.now || (() => new Date());
  const cap = options.freeWalletCap ?? FREE_WALLETS_PER_IP;
  const secret = options.ipHashSecret || randomBytes(32).toString('hex');
  const getWallet = db.prepare('SELECT * FROM wallets WHERE id = ?');
  const countGrants = db.prepare(
    'SELECT COUNT(*) AS n FROM free_grants WHERE ip_hash = ? AND created_at >= ?',
  );
  const deleteOldGrants = db.prepare('DELETE FROM free_grants WHERE created_at < ?');
  const insertGrant = db.prepare('INSERT INTO free_grants (ip_hash, created_at) VALUES (?, ?)');
  const insertWallet = db.prepare(
    `INSERT INTO wallets (id, balance, created_at, last_activity_at, free_grant, has_payment)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deductOne = db.prepare(
    'UPDATE wallets SET balance = balance - 1, last_activity_at = ? WHERE id = ? AND balance >= 1',
  );
  const refundOne = db.prepare(
    'UPDATE wallets SET balance = balance + 1, last_activity_at = ? WHERE id = ?',
  );
  const addCredits = db.prepare(
    'UPDATE wallets SET balance = balance + ?, has_payment = 1, last_activity_at = ? WHERE id = ?',
  );
  const insertClaim = db.prepare(
    `INSERT INTO claims (
      session_id, wallet_id, credits, price_id, amount_total, currency,
      payment_intent_id, charge_id, created_at, reversed,
      amount_refunded, credits_refunded, dispute_amount, dispute_status, credits_disputed,
      credits_dispute_taken
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const findClaim = db.prepare('SELECT * FROM claims WHERE session_id = ?');
  const findByCharge = db.prepare('SELECT * FROM claims WHERE charge_id = ?');
  const findByIntent = db.prepare('SELECT * FROM claims WHERE payment_intent_id = ?');
  const floorDeduct = db.prepare(
    'UPDATE wallets SET balance = MAX(0, balance - ?), last_activity_at = ? WHERE id = ?',
  );
  const bumpBalance = db.prepare(
    'UPDATE wallets SET balance = balance + ?, last_activity_at = ? WHERE id = ?',
  );
  const saveRefund = db.prepare(
    'UPDATE claims SET amount_refunded = ?, credits_refunded = ? WHERE session_id = ?',
  );
  const saveDispute = db.prepare(
    `UPDATE claims
     SET dispute_amount = ?, dispute_status = ?, credits_disputed = ?, credits_dispute_taken = ?
     WHERE session_id = ?`,
  );
  const findTombstone = db.prepare('SELECT session_id, claimed FROM claim_tombstones WHERE session_id = ?');
  const insertTombstone = db.prepare(
    'INSERT OR IGNORE INTO claim_tombstones (session_id, claimed) VALUES (?, 1)',
  );
  const selectOldClaims = db.prepare('SELECT session_id FROM claims WHERE created_at < ?');
  const findAdjByCharge = db.prepare('SELECT * FROM adjustments WHERE charge_id = ?');
  const findAdjByIntent = db.prepare('SELECT * FROM adjustments WHERE payment_intent_id = ?');
  const insertAdj = db.prepare(
    `INSERT INTO adjustments (
      charge_id, payment_intent_id, amount_refunded, charge_amount, dispute_amount, dispute_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateAdj = db.prepare(
    `UPDATE adjustments
     SET charge_id = ?, payment_intent_id = ?, amount_refunded = ?, charge_amount = ?,
         dispute_amount = ?, dispute_status = ?, updated_at = ?
     WHERE id = ?`,
  );
  const deleteAdj = db.prepare('DELETE FROM adjustments WHERE id = ?');
  const deleteIdleFree = db.prepare(
    `DELETE FROM wallets
     WHERE has_payment = 0
       AND id NOT IN (SELECT wallet_id FROM claims)
       AND last_activity_at < ?`,
  );
  const deleteOldClaims = db.prepare('DELETE FROM claims WHERE created_at < ?');
  const deleteOldAdjustments = db.prepare('DELETE FROM adjustments WHERE updated_at < ?');
  const deleteIdlePaid = db.prepare(
    `DELETE FROM wallets
     WHERE has_payment = 1 AND balance = 0 AND last_activity_at < ?`,
  );

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    }
  }

  function cutoff(ms) {
    return iso(new Date(now().getTime() - ms));
  }

  function pruneGrants() {
    deleteOldGrants.run(cutoff(FREE_GRANT_TTL_MS));
  }

  function pruneFreeWallets() {
    deleteIdleFree.run(cutoff(FREE_WALLET_IDLE_MS));
  }

  function grantCount(ip) {
    const hash = hashIp(ip, secret);
    if (!hash) return cap;
    const row = countGrants.get(hash, cutoff(FREE_GRANT_TTL_MS));
    return Number(row?.n || 0);
  }

  function pruneClaims() {
    const cutoffAt = cutoff(CLAIM_RETENTION_MS);
    for (const row of selectOldClaims.all(cutoffAt)) insertTombstone.run(row.session_id);
    deleteOldClaims.run(cutoffAt);
    deleteOldAdjustments.run(cutoffAt);
  }

  function prunePaidWallets() {
    deleteIdlePaid.run(cutoff(PAID_WALLET_IDLE_MS));
  }

  function pruneAll() {
    transaction(() => {
      pruneGrants();
      pruneFreeWallets();
      prunePaidWallets();
      pruneClaims();
    });
  }

  const pruneEvery = options.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
  const pruneTimer = setInterval(() => {
    try { pruneAll(); } catch (err) {
      console.error('prune failed');
      console.error(err?.message || 'unknown prune error');
    }
  }, pruneEvery);
  pruneTimer.unref?.();

  function preview(walletId, ip) {
    return transaction(() => {
      const row = getWallet.get(normalizeWalletId(walletId));
      if (row) return { exists: true, balance: row.balance, freeEligible: false };
      return { exists: false, balance: 0, freeEligible: grantCount(ip) < cap };
    });
  }

  function beginSummarize(walletId, ip) {
    const id = normalizeWalletId(walletId);
    return transaction(() => {
      let row = getWallet.get(id);
      if (!row) {
        if (grantCount(ip) >= cap) return { error: 'no_credits', balance: 0 };
        const ts = iso(now());
        insertWallet.run(id, FREE_CREDITS, ts, ts, 1, 0);
        insertGrant.run(hashIp(ip, secret), ts);
        row = getWallet.get(id);
      }
      if (row.balance < 1) return { error: 'no_credits', balance: row.balance };
      const ts = iso(now());
      const updated = deductOne.run(ts, id);
      if (!updated.changes) return { error: 'no_credits', balance: getWallet.get(id)?.balance ?? 0 };
      return { balance: row.balance - 1, reserved: true };
    });
  }

  function refundCredit(walletId) {
    return transaction(() => {
      const ts = iso(now());
      refundOne.run(ts, walletId);
      return { balance: getWallet.get(walletId)?.balance ?? 0 };
    });
  }

  function balanceOf(walletId) {
    const row = getWallet.get(normalizeWalletId(walletId));
    return row ? row.balance : 0;
  }

  function findClaimByRefs(chargeId, paymentIntentId) {
    if (chargeId) {
      const row = findByCharge.get(chargeId);
      if (row) return row;
    }
    if (paymentIntentId) return findByIntent.get(paymentIntentId);
    return null;
  }

  function findAdjustment(chargeId, paymentIntentId) {
    if (chargeId) {
      const row = findAdjByCharge.get(chargeId);
      if (row) return row;
    }
    if (paymentIntentId) return findAdjByIntent.get(paymentIntentId);
    return null;
  }

  function walletBalance(walletId) {
    return getWallet.get(walletId)?.balance ?? 0;
  }

  function deductFromWallet(walletId, amount) {
    if (amount <= 0) return 0;
    const before = walletBalance(walletId);
    floorDeduct.run(amount, iso(now()), walletId);
    return before - walletBalance(walletId);
  }

  function grantCredits(input) {
    const walletId = normalizeWalletId(input.walletId);
    return transaction(() => {
      const prior = findClaim.get(input.sessionId);
      if (prior) {
        return {
          alreadyClaimed: true,
          balance: walletBalance(prior.wallet_id),
          creditsAdded: 0,
          walletId: prior.wallet_id,
        };
      }
      if (findTombstone.get(input.sessionId)) {
        return {
          alreadyClaimed: true,
          balance: walletBalance(walletId),
          creditsAdded: 0,
          walletId,
          tombstone: true,
        };
      }
      const adj = findAdjustment(input.chargeId, input.paymentIntentId);
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
      if (!getWallet.get(walletId)) {
        insertWallet.run(walletId, 0, ts, ts, 0, 1);
      }
      addCredits.run(net, ts, walletId);
      insertClaim.run(
        input.sessionId,
        walletId,
        input.credits,
        input.priceId || null,
        input.amountTotal ?? null,
        input.currency || null,
        input.paymentIntentId || null,
        input.chargeId || null,
        ts,
        amountRefunded,
        creditsRefunded,
        disputeAmount,
        disputeStatus,
        creditsDisputed,
        disputeTaken,
      );
      if (adj) deleteAdj.run(adj.id);
      return {
        alreadyClaimed: false,
        balance: walletBalance(walletId),
        creditsAdded: net,
        walletId,
      };
    });
  }

  function rememberAdjustment({ chargeId, paymentIntentId, amountRefunded, chargeAmount, disputeAmount, disputeStatus }) {
    const existing = findAdjustment(chargeId, paymentIntentId);
    const ts = iso(now());
    if (!existing) {
      insertAdj.run(
        chargeId || null,
        paymentIntentId || null,
        amountRefunded || 0,
        chargeAmount ?? null,
        disputeAmount || 0,
        disputeStatus || null,
        ts,
      );
      return;
    }
    updateAdj.run(
      chargeId || existing.charge_id || null,
      paymentIntentId || existing.payment_intent_id || null,
      amountRefunded != null ? amountRefunded : existing.amount_refunded,
      chargeAmount ?? existing.charge_amount,
      disputeAmount != null ? disputeAmount : existing.dispute_amount,
      disputeStatus || existing.dispute_status,
      ts,
      existing.id,
    );
  }

  function applyRefund({ chargeId, paymentIntentId, amountRefunded, chargeAmount }) {
    return transaction(() => {
      const claim = findClaimByRefs(chargeId, paymentIntentId);
      const refunded = Number.isFinite(Number(amountRefunded))
        ? Number(amountRefunded)
        : Number(chargeAmount || 0);
      if (!claim) {
        if (!chargeId && !paymentIntentId) return { found: false, pending: false };
        rememberAdjustment({
          chargeId,
          paymentIntentId,
          amountRefunded: refunded,
          chargeAmount: chargeAmount ?? null,
        });
        return { found: false, pending: true, deducted: 0 };
      }
      const total = claim.amount_total || chargeAmount;
      const already = Number(claim.credits_refunded || 0);
      const target = Math.max(already, creditsToRemove(claim.credits, refunded, total));
      const delta = target - already;
      const room = Math.max(0, claim.credits - already - Number(claim.credits_disputed || 0));
      const applied = deductFromWallet(claim.wallet_id, Math.min(delta, room));
      saveRefund.run(refunded, target, claim.session_id);
      return {
        found: true,
        pending: false,
        deducted: applied,
        alreadyApplied: applied === 0,
        balance: walletBalance(claim.wallet_id),
        walletId: claim.wallet_id,
      };
    });
  }

  function applyDispute({ chargeId, paymentIntentId, amount, status, eventType }) {
    const effect = disputeEffect(status, eventType);
    const disputeStatus = String(status || '');
    return transaction(() => {
      const claim = findClaimByRefs(chargeId, paymentIntentId);
      if (!claim) {
        if (!chargeId && !paymentIntentId) return { found: false, pending: false };
        const existing = findAdjustment(chargeId, paymentIntentId);
        rememberAdjustment({
          chargeId,
          paymentIntentId,
          amountRefunded: existing ? existing.amount_refunded : 0,
          chargeAmount: existing ? existing.charge_amount : null,
          disputeAmount: Number(amount || 0),
          disputeStatus,
        });
        return { found: false, pending: true, deducted: 0, restored: 0 };
      }
      if (effect === 'restore') {
        const restore = Number(claim.credits_dispute_taken || 0);
        if (restore > 0) bumpBalance.run(restore, iso(now()), claim.wallet_id);
        saveDispute.run(
          Number(amount || claim.dispute_amount || 0),
          disputeStatus,
          Number(claim.credits_disputed || 0),
          0,
          claim.session_id,
        );
        return {
          found: true,
          pending: false,
          restored: restore,
          deducted: 0,
          balance: walletBalance(claim.wallet_id),
          walletId: claim.wallet_id,
        };
      }
      if (effect !== 'deduct') {
        saveDispute.run(
          Number(amount || claim.dispute_amount || 0),
          disputeStatus,
          Number(claim.credits_disputed || 0),
          Number(claim.credits_dispute_taken || 0),
          claim.session_id,
        );
        return {
          found: true,
          pending: false,
          deducted: 0,
          restored: 0,
          alreadyApplied: true,
          balance: walletBalance(claim.wallet_id),
          walletId: claim.wallet_id,
        };
      }
      const total = claim.amount_total;
      const already = Number(claim.credits_disputed || 0);
      const target = Math.max(already, creditsToRemove(claim.credits, amount, total));
      const delta = target - already;
      const room = Math.max(0, claim.credits - Number(claim.credits_refunded || 0) - already);
      const applied = deductFromWallet(claim.wallet_id, Math.min(delta, room));
      const taken = Number(claim.credits_dispute_taken || 0) + applied;
      saveDispute.run(Number(amount || 0), disputeStatus, target, taken, claim.session_id);
      return {
        found: true,
        pending: false,
        deducted: applied,
        restored: 0,
        alreadyApplied: delta === 0,
        balance: walletBalance(claim.wallet_id),
        walletId: claim.wallet_id,
      };
    });
  }

  function close() {
    clearInterval(pruneTimer);
    db.close();
  }

  return {
    ok: true,
    file,
    ephemeralSecret: !options.ipHashSecret,
    preview,
    beginSummarize,
    refundCredit,
    balanceOf,
    grantCredits,
    applyRefund,
    applyDispute,
    pruneNow: pruneAll,
    close,
  };
}
