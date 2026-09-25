import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FREE_CREDITS = 2;
export const FREE_WALLETS_PER_IP_PER_DAY = 5;

const WALLET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWalletId(value) {
  return typeof value === 'string' && WALLET_RE.test(value);
}

function emptyBook() {
  return { wallets: {}, claims: {}, freeGrants: {} };
}

function ipKey(ip) {
  return createHash('sha256').update(String(ip)).digest('hex');
}

/**
 * Register a wallet once. The same id returns the existing balance.
 * The first wallets from an IP each UTC day get FREE_CREDITS; further
 * wallets from that IP are created at 0 so they can still be topped up.
 */
export function ensureWallet(data, walletId, ip, now, cap = FREE_WALLETS_PER_IP_PER_DAY) {
  const existing = data.wallets[walletId];
  if (existing) return { balance: existing.balance, created: false };

  const day = now.toISOString().slice(0, 10);
  for (const key of Object.keys(data.freeGrants)) {
    if (data.freeGrants[key]?.day !== day) delete data.freeGrants[key];
  }

  const key = ipKey(ip);
  const grant = data.freeGrants[key] || { day, count: 0 };
  let balance = 0;
  if (grant.count < cap) {
    balance = FREE_CREDITS;
    grant.count += 1;
    grant.day = day;
    data.freeGrants[key] = grant;
  }

  data.wallets[walletId] = { balance, createdAt: now.toISOString() };
  return { balance, created: true };
}

/** Idempotent per Stripe Checkout session id. */
export function grantCredits(data, { sessionId, walletId, credits, at }) {
  const prior = data.claims[sessionId];
  if (prior) {
    return {
      alreadyClaimed: true,
      balance: data.wallets[prior.walletId]?.balance ?? 0,
      creditsAdded: 0,
    };
  }
  if (!data.wallets[walletId]) {
    data.wallets[walletId] = { balance: 0, createdAt: at };
  }
  data.wallets[walletId].balance += credits;
  data.claims[sessionId] = { walletId, credits, at };
  return {
    alreadyClaimed: false,
    balance: data.wallets[walletId].balance,
    creditsAdded: credits,
  };
}

export function reserveCredit(data, walletId) {
  const wallet = data.wallets[walletId];
  if (!wallet) return { error: 'unknown_wallet' };
  if (wallet.balance < 1) return { error: 'no_credits', balance: wallet.balance };
  wallet.balance -= 1;
  return { balance: wallet.balance };
}

export function refundCredit(data, walletId) {
  const wallet = data.wallets[walletId];
  if (!wallet) return { balance: 0 };
  wallet.balance += 1;
  return { balance: wallet.balance };
}

/**
 * JSON file store for one Node process. Mutations are serialized in-process
 * and written with a temp file + rename. Do not point several processes at
 * the same file.
 */
export function createWalletStore(dataDir) {
  const file = path.join(dataDir, 'wallets.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let chain = Promise.resolve();

  function read() {
    if (!fs.existsSync(file)) return emptyBook();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('wallet store is corrupt');
    }
    if (!data.wallets || typeof data.wallets !== 'object') data.wallets = {};
    if (!data.claims || typeof data.claims !== 'object') data.claims = {};
    if (!data.freeGrants || typeof data.freeGrants !== 'object') data.freeGrants = {};
    return data;
  }

  function write(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function update(mutator) {
    const run = chain.then(async () => {
      const data = read();
      const result = await mutator(data);
      write(data);
      return result;
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return { update, file };
}
