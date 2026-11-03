import path from 'node:path';

/** Languages we keep. Anything else, including a missing or malformed tag, is `other`. */
export const LANG_WHITELIST = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'tr', 'ar', 'zh', 'ja'];
const LANGS = new Set(LANG_WHITELIST);

export const EVENT_NAMES = new Set(['reader_started', 'summary_purchased']);

/** Known HTML routes. Every other page request shares the `other` bucket so a unique URL is never logged. */
export const PAGE_GROUPS = new Set([
  '/',
  '/privacy',
  '/rsvp',
  '/ai-summary',
  '/for-builders',
  '/read-long-pdf',
  '/wetenschappelijke-artikelen',
  '/literatuuronderzoek-scriptie',
  '/rapporten-en-beleidsstukken-lezen',
  '/studieboeken-tentamen',
]);

export const LANG_AGG_INTERVAL_MS = 10 * 60 * 1000;

const BEACON_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const BEACON_CONNECT_ORIGIN = 'https://cloudflareinsights.com';

/**
 * Primary language: the first Accept-Language tag, reduced to its 2-letter
 * subtag. `nl-NL,en;q=0.8` is `nl`. A higher q later in the list does not win.
 * Unknown, empty, or non-whitelisted tags are `other`.
 */
export function languageFromAccept(header) {
  const first = String(header || '').split(',')[0] || '';
  const tag = first.split(';')[0].trim().toLowerCase();
  const sub = tag.split('-')[0];
  if (!/^[a-z]{2}$/.test(sub)) return 'other';
  return LANGS.has(sub) ? sub : 'other';
}

export function acceptsHtml(header) {
  return String(header || '').toLowerCase().includes('text/html');
}

/** A static file, not an HTML page. HTML documents themselves are pages. */
export function isAssetPath(pathname) {
  const clean = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (clean === '/assets' || clean.startsWith('/assets/')) return true;
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  if (base.startsWith('.')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext !== 'html' && ext !== 'htm';
}

export function pathGroup(pathname) {
  let clean = String(pathname || '').split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return 'other';
  }
  clean = path.posix.normalize(clean.startsWith('/') ? clean : `/${clean}`);
  if (clean.length > 1) clean = clean.replace(/\/+$/, '');
  if (clean === '/index.html') return '/';
  if (clean.endsWith('/index.html')) {
    const parent = clean.slice(0, -'/index.html'.length) || '/';
    if (PAGE_GROUPS.has(parent)) return parent;
  }
  return PAGE_GROUPS.has(clean) ? clean : 'other';
}

/**
 * Probe paths that must be a bare 404. They must not fall through to the
 * homepage or to express.static.
 */
export function isSensitivePath(pathname) {
  const raw = String(pathname || '').split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  let normalized = path.posix.normalize(decoded.startsWith('/') ? decoded : `/${decoded}`);
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  const lower = normalized.toLowerCase();
  if (lower === '/server.js' || lower === '/package.json' || lower === '/xmlrpc.php' || lower === '/.ds_store') return true;
  if (lower.startsWith('/.env')) return true;
  if (lower === '/.git' || lower.startsWith('/.git/')) return true;
  if (lower.startsWith('/wp-')) return true;
  if (lower === '/node_modules' || lower.startsWith('/node_modules/')) return true;
  return false;
}

function canonicalLang(lang) {
  return LANGS.has(lang) || lang === 'other' ? lang : 'other';
}

function canonicalGroup(group) {
  return PAGE_GROUPS.has(group) || group === 'other' ? group : 'other';
}

/**
 * In-memory totals for one process. The flush line is counts by language,
 * path group, and event. It never receives an IP, user agent, or query string.
 * An empty window writes nothing.
 */
export function createLangAggregator(options = {}) {
  const intervalMs = options.intervalMs === undefined ? LANG_AGG_INTERVAL_MS : Number(options.intervalMs);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const write = typeof options.write === 'function'
    ? options.write
    : (line) => { console.log(line); };

  function stamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    return new Date(date.getTime());
  }

  let windowStart = stamp();
  let counts = {};
  let paths = {};
  let events = {};

  function notePage(lang, group) {
    const language = canonicalLang(lang);
    const bucket = canonicalGroup(group);
    counts[language] = (counts[language] || 0) + 1;
    const row = paths[bucket] || (paths[bucket] = {});
    row[language] = (row[language] || 0) + 1;
  }

  function noteEvent(lang, name) {
    if (!EVENT_NAMES.has(name)) return;
    const language = canonicalLang(lang);
    const row = events[name] || (events[name] = {});
    row[language] = (row[language] || 0) + 1;
  }

  function flush() {
    const end = stamp();
    const hasCounts = Object.keys(counts).length > 0;
    const hasEvents = Object.keys(events).length > 0;
    let line = null;
    if (hasCounts || hasEvents) {
      const payload = {
        type: 'sr_lang_agg',
        window_start: windowStart.toISOString(),
        window_end: end.toISOString(),
        counts,
      };
      if (hasCounts) payload.paths = paths;
      if (hasEvents) payload.events = events;
      line = JSON.stringify(payload);
      write(line);
    }
    counts = {};
    paths = {};
    events = {};
    windowStart = end;
    return line;
  }

  let timer = null;
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    timer = setInterval(flush, intervalMs);
    timer.unref?.();
  }

  return {
    notePage,
    noteEvent,
    flush,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Cloudflare beacon tokens are a single URL-safe token. Anything else is ignored. */
export function normalizeBeaconToken(token) {
  const raw = String(token ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return '';
  return raw;
}

export function beaconSnippet(token) {
  const safe = normalizeBeaconToken(token);
  if (!safe) return '';
  return `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token":"${safe}"}'></script>`;
}

function directiveName(part) {
  return String(part || '').trim().split(/\s+/)[0].toLowerCase();
}

/**
 * Widen an existing CSP so the beacon can load and report.
 * A policy without script-src/connect-src inherits default-src, so those
 * directives are added with the default-src sources plus the beacon origin.
 * A policy that does not restrict scripts or connections is left unchanged.
 */
export function cspWithBeacon(policy) {
  const raw = String(policy || '').trim();
  if (!raw) return raw;
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean);
  const indexOf = (name) => parts.findIndex((part) => directiveName(part) === name);
  const hasSource = (part, source) => part.split(/\s+/).includes(source);

  function widen(name, source) {
    const index = indexOf(name);
    if (index !== -1) {
      if (!hasSource(parts[index], source)) parts[index] = `${parts[index]} ${source}`;
      return;
    }
    const fallback = indexOf('default-src');
    if (fallback === -1) return;
    const base = parts[fallback].split(/\s+/).slice(1);
    const tokens = base.includes(source) ? base : [...base, source];
    parts.push(`${name} ${tokens.join(' ')}`.trim());
  }

  widen('script-src', BEACON_SCRIPT_ORIGIN);
  if (indexOf('script-src-elem') !== -1) widen('script-src-elem', BEACON_SCRIPT_ORIGIN);
  widen('connect-src', BEACON_CONNECT_ORIGIN);
  return parts.join('; ');
}

export function injectBeacon(html, token) {
  const tag = beaconSnippet(token);
  const source = String(html);
  if (!tag || source.includes(tag)) return source;
  const withCsp = source.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(['"])Content-Security-Policy\1[^>]*>/gi,
    (meta) => meta.replace(
      /content\s*=\s*(['"])([\s\S]*?)\1/i,
      (full, quote, content) => `content=${quote}${cspWithBeacon(content)}${quote}`,
    ),
  );
  if (/<\/body>/i.test(withCsp)) return withCsp.replace(/<\/body>/i, `${tag}</body>`);
  return `${withCsp}${tag}`;
}
