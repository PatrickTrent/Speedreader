import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FREE_CREDITS = 2;
export const FREE_WALLETS_PER_IP = 5;
export const FREE_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
export const FREE_WALLET_IDLE_MS = 180 * 24 * 60 * 60 * 1000;

const WALLET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWalletId(value) {
  return typeof value === 'string' && WALLET_RE.test(value);
}

/** IPv4 as-is. IPv6 collapsed to its /64 so one network shares one bucket. */
export function groupIp(ip) {
  if (!ip) return 'unknown';
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
  return 'unknown';
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
  return createHmac('sha256', String(secret)).update(groupIp(ip)).digest('hex');
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
  if (nodeEnv !== 'production') return null;
  if (!dataDir) return 'DATA_DIR is unset';
  const resolved = path.resolve(dataDir);
  for (const root of [path.resolve(appRoot), path.resolve(cwd)]) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return `DATA_DIR (${resolved}) is inside the deploy directory (${root})`;
    }
  }
  if (!ipHashSecret) return 'IP_HASH_SECRET is unset';
  return null;
}

function iso(date) {
  return date.toISOString();
}

export function openWalletStore(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'wallets.sqlite');
  let db;
  try {
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
        reversed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_claims_pi ON claims(payment_intent_id);
      CREATE INDEX IF NOT EXISTS idx_claims_charge ON claims(charge_id);
      CREATE TABLE IF NOT EXISTS free_grants (
        ip_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_free_grants_hash ON free_grants(ip_hash, created_at);
    `);
  } catch (err) {
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
      payment_intent_id, charge_id, created_at, reversed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const findClaim = db.prepare('SELECT * FROM claims WHERE session_id = ?');
  const findByCharge = db.prepare('SELECT * FROM claims WHERE charge_id = ?');
  const findByIntent = db.prepare('SELECT * FROM claims WHERE payment_intent_id = ?');
  const markReversed = db.prepare('UPDATE claims SET reversed = 1 WHERE session_id = ? AND reversed = 0');
  const floorDeduct = db.prepare(
    'UPDATE wallets SET balance = MAX(0, balance - ?), last_activity_at = ? WHERE id = ?',
  );
  const deleteIdleFree = db.prepare(
    `DELETE FROM wallets
     WHERE has_payment = 0
       AND id NOT IN (SELECT wallet_id FROM claims)
       AND last_activity_at < ?`,
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
    const row = countGrants.get(hashIp(ip, secret), cutoff(FREE_GRANT_TTL_MS));
    return Number(row?.n || 0);
  }

  function preview(walletId, ip) {
    return transaction(() => {
      pruneGrants();
      pruneFreeWallets();
      const row = getWallet.get(walletId);
      if (row) return { exists: true, balance: row.balance, freeEligible: false };
      return { exists: false, balance: 0, freeEligible: grantCount(ip) < cap };
    });
  }

  function beginSummarize(walletId, ip) {
    return transaction(() => {
      pruneGrants();
      pruneFreeWallets();
      let row = getWallet.get(walletId);
      if (!row) {
        if (grantCount(ip) >= cap) return { error: 'no_credits', balance: 0 };
        const ts = iso(now());
        insertWallet.run(walletId, FREE_CREDITS, ts, ts, 1, 0);
        insertGrant.run(hashIp(ip, secret), ts);
        row = getWallet.get(walletId);
      }
      if (row.balance < 1) return { error: 'no_credits', balance: row.balance };
      const ts = iso(now());
      const updated = deductOne.run(ts, walletId);
      if (!updated.changes) return { error: 'no_credits', balance: getWallet.get(walletId)?.balance ?? 0 };
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
    const row = getWallet.get(walletId);
    return row ? row.balance : 0;
  }

  function grantCredits(input) {
    return transaction(() => {
      const prior = findClaim.get(input.sessionId);
      if (prior) {
        return {
          alreadyClaimed: true,
          balance: getWallet.get(prior.wallet_id)?.balance ?? 0,
          creditsAdded: 0,
          walletId: prior.wallet_id,
        };
      }
      const ts = iso(now());
      if (!getWallet.get(input.walletId)) {
        insertWallet.run(input.walletId, 0, ts, ts, 0, 1);
      }
      addCredits.run(input.credits, ts, input.walletId);
      insertClaim.run(
        input.sessionId,
        input.walletId,
        input.credits,
        input.priceId || null,
        input.amountTotal ?? null,
        input.currency || null,
        input.paymentIntentId || null,
        input.chargeId || null,
        ts,
      );
      return {
        alreadyClaimed: false,
        balance: getWallet.get(input.walletId).balance,
        creditsAdded: input.credits,
        walletId: input.walletId,
      };
    });
  }

  function reversePurchase({ chargeId, paymentIntentId }) {
    return transaction(() => {
      let claim = chargeId ? findByCharge.get(chargeId) : null;
      if (!claim && paymentIntentId) claim = findByIntent.get(paymentIntentId);
      if (!claim) return { found: false };
      if (claim.reversed) {
        return {
          found: true,
          alreadyReversed: true,
          balance: getWallet.get(claim.wallet_id)?.balance ?? 0,
          walletId: claim.wallet_id,
          deducted: 0,
        };
      }
      const ts = iso(now());
      const marked = markReversed.run(claim.session_id);
      if (!marked.changes) {
        return {
          found: true,
          alreadyReversed: true,
          balance: getWallet.get(claim.wallet_id)?.balance ?? 0,
          walletId: claim.wallet_id,
          deducted: 0,
        };
      }
      floorDeduct.run(claim.credits, ts, claim.wallet_id);
      return {
        found: true,
        alreadyReversed: false,
        deducted: claim.credits,
        balance: getWallet.get(claim.wallet_id)?.balance ?? 0,
        walletId: claim.wallet_id,
      };
    });
  }

  function close() {
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
    reversePurchase,
    close,
  };
}
