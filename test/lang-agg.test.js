import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { COMPANY_LINE } from '../lib/company.js';
import { EVENT_RATE_MAX } from '../lib/http.js';
import {
  EVENT_NAMES,
  LANG_AGG_INTERVAL_MS,
  acceptsHtml,
  beaconSnippet,
  createLangAggregator,
  cspWithBeacon,
  injectBeacon,
  isAssetPath,
  isSensitivePath,
  languageFromAccept,
  normalizeBeaconToken,
  pathGroup,
} from '../lib/lang-agg.js';

const HTML = '<!DOCTYPE html><html><head><title>Privacy</title></head><body><p>{{COMPANY_LINE}}</p></body></html>';
const BEACON_TOKEN = 'beaconTokenTest123';
const BEACON_TAG = `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token":"${BEACON_TOKEN}"}'></script>`;

function planted(files) {
  const rows = [];
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.resolve('dist', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const previous = existed ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, contents);
    rows.push({ file, existed, previous });
  }
  return () => {
    for (const row of rows.reverse()) {
      if (row.existed) fs.writeFileSync(row.file, row.previous);
      else rmSync(row.file, { force: true });
    }
  };
}

async function withApp(opts, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'speedreader-lang-'));
  const lines = [];
  const app = createApp({
    dataDir,
    stripe: null,
    summariesConfigured: false,
    trustCloudflare: false,
    ipHashSecret: 'test-salt',
    beaconToken: '',
    langAggIntervalMs: 0,
    langAggWrite: (line) => lines.push(line),
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, { app, lines });
  } finally {
    app.closeStore();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function page(base, requestPath, headers = {}) {
  return fetch(`${base}${requestPath}`, {
    headers: { accept: 'text/html', ...headers },
  });
}

test('language, path group, assets, and probe paths', () => {
  assert.equal(languageFromAccept('nl-NL,nl;q=0.9,en;q=0.8'), 'nl');
  assert.equal(languageFromAccept('EN-us'), 'en');
  assert.equal(languageFromAccept('de;q=0.1,nl;q=0.9'), 'de');
  assert.equal(languageFromAccept('fr-FR'), 'fr');
  assert.equal(languageFromAccept('pt-BR'), 'pt');
  assert.equal(languageFromAccept('zh-Hans-CN'), 'zh');
  assert.equal(languageFromAccept('sv-SE,en;q=0.8'), 'other');
  assert.equal(languageFromAccept('*'), 'other');
  assert.equal(languageFromAccept(''), 'other');
  assert.equal(languageFromAccept('eng'), 'other');
  assert.equal(languageFromAccept('e'), 'other');
  assert.equal(languageFromAccept('i-klingon'), 'other');
  assert.equal(acceptsHtml('text/html,application/xhtml+xml'), true);
  assert.equal(acceptsHtml('text/HTML'), true);
  assert.equal(acceptsHtml('*/*'), false);
  assert.equal(acceptsHtml(''), false);

  assert.equal(pathGroup('/privacy'), '/privacy');
  assert.equal(pathGroup('/privacy/'), '/privacy');
  assert.equal(pathGroup('/privacy?session_id=cs_test'), '/privacy');
  assert.equal(pathGroup('/index.html'), '/');
  assert.equal(pathGroup('/rsvp/index.html'), '/rsvp');
  assert.equal(pathGroup('/someone/private-note'), 'other');
  assert.equal(isAssetPath('/tw.css'), true);
  assert.equal(isAssetPath('/assets/index-abc.js'), true);
  assert.equal(isAssetPath('/sitemap.xml'), true);
  assert.equal(isAssetPath('/.env'), true);
  assert.equal(isAssetPath('/privacy'), false);
  assert.equal(isAssetPath('/index.html'), false);

  assert.equal(isSensitivePath('/.env'), true);
  assert.equal(isSensitivePath('/.env.local'), true);
  assert.equal(isSensitivePath('/%2eenv'), true);
  assert.equal(isSensitivePath('/foo/../../.env'), true);
  assert.equal(isSensitivePath('/.git/config'), true);
  assert.equal(isSensitivePath('/.git'), true);
  assert.equal(isSensitivePath('/wp-login.php'), true);
  assert.equal(isSensitivePath('/wp-admin/install.php'), true);
  assert.equal(isSensitivePath('/WP-Admin'), true);
  assert.equal(isSensitivePath('/xmlrpc.php'), true);
  assert.equal(isSensitivePath('/.DS_Store'), true);
  assert.equal(isSensitivePath('/server.js'), true);
  assert.equal(isSensitivePath('/package.json'), true);
  assert.equal(isSensitivePath('/node_modules/express/index.js'), true);
  assert.equal(isSensitivePath('/privacy'), false);
  assert.equal(isSensitivePath('/api/event'), false);
  assert.equal(LANG_AGG_INTERVAL_MS, 600_000);
  assert.equal(EVENT_NAMES.has('reader_started'), true);
  assert.equal(EVENT_NAMES.has('summary_purchased'), true);
  assert.equal(EVENT_RATE_MAX, 600);
});

test('flush writes one aggregate line and then resets', () => {
  const lines = [];
  let t = Date.parse('2026-03-01T00:00:00.000Z');
  const agg = createLangAggregator({
    intervalMs: 0,
    now: () => new Date(t),
    write: (line) => lines.push(line),
  });
  assert.equal(agg.flush(), null);
  agg.notePage('nl', '/');
  agg.notePage('nl', '/privacy');
  agg.notePage('sv', '/not-a-real-page');
  agg.noteEvent('fr', 'reader_started');
  agg.noteEvent('fr', 'reader_started');
  agg.noteEvent('en', 'summary_purchased');
  agg.noteEvent('en', 'not_an_event');
  t += 600_000;
  const line = agg.flush();
  agg.stop();
  assert.equal(lines.length, 1);
  assert.equal(line, lines[0]);
  assert.equal(line.includes('\n'), false);
  const body = JSON.parse(line);
  assert.equal(body.type, 'sr_lang_agg');
  assert.equal(body.window_start, '2026-03-01T00:00:00.000Z');
  assert.equal(body.window_end, '2026-03-01T00:10:00.000Z');
  assert.deepEqual(body.counts, { nl: 2, other: 1 });
  assert.deepEqual(body.paths, { '/': { nl: 1 }, '/privacy': { nl: 1 }, other: { other: 1 } });
  assert.deepEqual(body.events, { reader_started: { fr: 2 }, summary_purchased: { en: 1 } });
  assert.equal(JSON.stringify(body).includes('not-a-real-page'), false);
  assert.equal(agg.flush(), null);
  assert.equal(lines.length, 1);
});

test('the interval flushes to stdout as one JSON line', async () => {
  const lines = [];
  const agg = createLangAggregator({
    intervalMs: 20,
    write: (line) => lines.push(line),
  });
  agg.notePage('ja', '/rsvp');
  const start = Date.now();
  while (lines.length === 0 && Date.now() - start < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  agg.stop();
  assert.equal(lines.length >= 1, true);
  const body = JSON.parse(lines[0]);
  assert.equal(body.type, 'sr_lang_agg');
  assert.deepEqual(body.counts, { ja: 1 });
  assert.deepEqual(body.paths['/rsvp'], { ja: 1 });
});

test('beacon snippet and CSP stay absent unless a safe token and a policy exist', () => {
  assert.equal(normalizeBeaconToken(''), '');
  assert.equal(normalizeBeaconToken('  abc_DEF-123  '), 'abc_DEF-123');
  assert.equal(normalizeBeaconToken('bad token'), '');
  assert.equal(normalizeBeaconToken('"><script>'), '');
  assert.equal(beaconSnippet(''), '');
  assert.equal(beaconSnippet(BEACON_TOKEN), BEACON_TAG);
  assert.equal(injectBeacon(HTML, ''), HTML);
  assert.equal(injectBeacon(HTML, 'bad token'), HTML);
  const injected = injectBeacon(HTML, BEACON_TOKEN);
  assert.ok(injected.includes(`${BEACON_TAG}</body>`));
  assert.equal(injected.includes(BEACON_TAG + BEACON_TAG), false);

  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
  const withMeta = injectBeacon(`<head>${meta}</head><body></body>`, BEACON_TOKEN);
  assert.match(withMeta, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
  assert.match(withMeta, /connect-src 'self' https:\/\/cloudflareinsights\.com/);
  assert.equal(cspWithBeacon(''), '');
  assert.equal(
    cspWithBeacon("script-src 'self'; connect-src 'self'"),
    "script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com",
  );
  assert.equal(
    cspWithBeacon("script-src 'self' https://static.cloudflareinsights.com"),
    "script-src 'self' https://static.cloudflareinsights.com",
  );
  const widened = cspWithBeacon("default-src 'self'; script-src-elem 'self'");
  assert.match(widened, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
  assert.match(widened, /script-src-elem 'self' https:\/\/static\.cloudflareinsights\.com/);
  assert.equal(cspWithBeacon('frame-ancestors \'none\'').includes('cloudflareinsights'), false);
});

test('HTML page views aggregate by language and path group without IP, query, or user agent', async () => {
  const secret = 'QUERYSECRET-9f3a';
  const agent = 'UA-SECRET-9f3a';
  const restore = planted({
    'index.html': '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    'privacy/index.html': HTML,
  });
  try {
  await withApp({}, async (base, { app, lines }) => {
    const home = await page(base, `/?session_id=${secret}`, { 'accept-language': 'nl-NL,en;q=0.8', 'user-agent': agent });
    assert.equal(home.status, 200);

    const privacy = await page(base, `/privacy?session_id=${secret}`, { 'accept-language': 'de;q=0.1,nl;q=0.9', 'user-agent': agent });
    assert.equal(privacy.status, 200);

    const other = await page(base, '/not-a-published-page', { 'accept-language': 'sv-SE' });
    assert.equal(other.status, 404);

    const asset = await page(base, '/tw.css', { 'accept-language': 'fr' });
    assert.equal(asset.status === 200 || asset.status === 404, true);
    const bundled = await page(base, '/assets/app.js', { 'accept-language': 'es' });
    assert.equal(bundled.status === 200 || bundled.status === 404, true);

    const api = await fetch(`${base}/api/config`, { headers: { accept: 'text/html', 'accept-language': 'it' } });
    assert.equal(api.status, 200);

    const star = await fetch(`${base}/privacy`, { headers: { accept: '*/*', 'accept-language': 'pl' } });
    assert.equal(star.status === 200 || star.status === 404, true);
    const posted = await fetch(`${base}/privacy`, { method: 'POST', headers: { accept: 'text/html', 'accept-language': 'tr' } });
    assert.equal(posted.status === 404 || posted.status === 200, true);

    assert.equal(app.flushLangAgg() === null, false);
    assert.equal(lines.length, 1);
    const body = JSON.parse(lines[0]);
    assert.deepEqual(body.counts, { nl: 1, de: 1, other: 1 });
    assert.deepEqual(body.paths['/'], { nl: 1 });
    assert.deepEqual(body.paths['/privacy'], { de: 1 });
    assert.deepEqual(body.paths.other, { other: 1 });
    assert.equal(body.events, undefined);
    const raw = lines[0];
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes(agent), false);
    assert.equal(raw.includes('127.0.0.1'), false);
    assert.equal(raw.includes('user-agent'), false);
    assert.equal(raw.includes('session_id'), false);
    assert.equal(app.flushLangAgg(), null);
  });
  } finally {
    restore();
  }
});

test('POST /api/event counts whitelisted names and rate limits without a per-IP bucket', async () => {
  await withApp({ exposeInternals: true }, async (base, { app, lines }) => {
    const ok = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'nl-BE,en;q=0.5',
        'user-agent': 'UA-SECRET-9f3a',
      },
      body: JSON.stringify({ name: 'reader_started', lang: 'zz', url: 'https://evil.test/?q=QUERYSECRET-9f3a' }),
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('etag'), null);
    assert.equal(ok.headers.get('vary'), null);
    assert.equal(await ok.text(), '');

    const bought = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': 'ar' },
      body: JSON.stringify({ name: 'summary_purchased' }),
    });
    assert.equal(bought.status, 204);

    for (const body of [{}, { name: 'page_view' }, { name: ['reader_started'] }, { name: 'reader_started ' }]) {
      const bad = await fetch(`${base}/api/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'en' },
        body: JSON.stringify(body),
      });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: 'invalid_event' });
    }

    const line = app.flushLangAgg();
    const body = JSON.parse(line);
    assert.equal(body.counts && Object.keys(body.counts).length, 0);
    assert.equal(body.paths, undefined);
    assert.deepEqual(body.events, {
      reader_started: { nl: 1 },
      summary_purchased: { ar: 1 },
    });
    assert.equal(line.includes('QUERYSECRET-9f3a'), false);
    assert.equal(line.includes('UA-SECRET-9f3a'), false);
    assert.equal(line.includes('127.0.0.1'), false);
    assert.equal(line.includes('zz'), false);
    assert.equal(app.limiterSize('event'), 1);
  });

  await withApp({
    exposeInternals: true,
    rateLimits: { event: { windowMs: 60_000, max: 2 } },
  }, async (base, { app, lines }) => {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/api/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'en' },
        body: JSON.stringify({ name: 'reader_started' }),
      });
      assert.equal(res.status, 204);
    }
    const limited = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': 'en' },
      body: JSON.stringify({ name: 'reader_started' }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
    const body = JSON.parse(app.flushLangAgg());
    assert.deepEqual(body.events.reader_started, { en: 2 });
    assert.equal(lines[0].includes('127.0.0.1'), false);
  });
});

test('an origin secret rejects /api/event before it is counted', async () => {
  const secret = 'o'.repeat(32);
  await withApp({ originSecret: secret }, async (base, { app, lines }) => {
    const denied = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': 'nl' },
      body: JSON.stringify({ name: 'reader_started' }),
    });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-language': 'nl',
        'x-origin-secret': secret,
      },
      body: JSON.stringify({ name: 'reader_started' }),
    });
    assert.equal(allowed.status, 204);
    const body = JSON.parse(app.flushLangAgg());
    assert.deepEqual(body.events.reader_started, { nl: 1 });
    assert.equal(lines.length, 1);
  });
});

test('the beacon is injected into HTML pages only when CF_BEACON_TOKEN is set, and an existing CSP is widened', async () => {
  const restore = planted({
    'index.html': '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>',
    'privacy/index.html': HTML,
    'rsvp/index.html': HTML,
  });
  try {
    await withApp({ beaconToken: '' }, async (base) => {
      const privacy = await page(base, '/privacy');
      const html = await privacy.text();
      assert.equal(privacy.status, 200);
      assert.equal(html.includes('cloudflareinsights'), false);
      assert.ok(html.includes(COMPANY_LINE));
      const home = await page(base, '/');
      assert.equal((await home.text()).includes('cloudflareinsights'), false);
    });

    await withApp({
      beaconToken: BEACON_TOKEN,
      contentSecurityPolicy: "default-src 'self'",
    }, async (base) => {
      for (const route of ['/', '/index.html', '/privacy', '/privacy/', '/rsvp', '/privacy/index.html']) {
        const res = await page(base, route);
        assert.equal(res.status, 200, route);
        const html = await res.text();
        assert.ok(html.includes(BEACON_TAG), route);
        assert.ok(html.includes(`${BEACON_TAG}</body>`), route);
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
        assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com/);
      }
      const missing = await page(base, '/no-such-beacon-page');
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type') || '', /text\/html/);
      assert.ok((await missing.text()).includes(BEACON_TAG));
    });

    const errors = [];
    const orig = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      await withApp({ beaconToken: 'not a token' }, async (base) => {
        const html = await (await page(base, '/privacy')).text();
        assert.equal(html.includes('cloudflareinsights'), false);
        assert.equal(html.includes('not a token'), false);
      });
    } finally {
      console.error = orig;
    }
    assert.ok(errors.some((line) => line.includes('CF_BEACON_TOKEN is set but ignored')));
    assert.equal(errors.some((line) => line.includes('not a token')), false);
  } finally {
    restore();
  }
});

test('sensitive paths are a bare 404 and dotfiles are not served', async () => {
  const marker = 'PROBE_SHOULD_NOT_LEAK_9f3a';
  const spa = `<!DOCTYPE html><html><body><div id="root">${marker}-spa</div></body></html>`;
  const restore = planted({
    'index.html': spa,
    '.env': marker,
    '.env.local': marker,
    '.hidden-probe': marker,
    '.git/HEAD': marker,
    '.DS_Store': marker,
    'server.js': marker,
    'package.json': `{"probe":"${marker}"}`,
    'node_modules/leftpad/index.js': marker,
    'wp-login.php': marker,
    'wp-admin/index.php': marker,
    'xmlrpc.php': marker,
    'assets/.hidden': marker,
  });
  try {
    await withApp({}, async (base) => {
      const probes = [
        '/.env',
        '/.env.local',
        '/%2eenv',
        '/.git/HEAD',
        '/.git/config',
        '/.DS_Store',
        '/server.js',
        '/server.js?token=QUERYSECRET-9f3a',
        '/package.json',
        '/node_modules/leftpad/index.js',
        '/wp-login.php',
        '/wp-admin',
        '/wp-admin/index.php',
        '/wp-includes/wlwmanifest.xml',
        '/xmlrpc.php',
        '/WP-Login.php',
      ];
      for (const route of probes) {
        for (const method of route === '/server.js' ? ['GET', 'POST'] : ['GET']) {
          const res = await fetch(`${base}${route}`, { method, headers: { accept: 'text/html' } });
          const text = await res.text();
          assert.equal(res.status, 404, `${method} ${route}`);
          assert.match(res.headers.get('content-type') || '', /text\/plain/, route);
          assert.equal(text, 'Not found', route);
          assert.equal(text.includes(marker), false, route);
          assert.equal(text.includes('<html'), false, route);
          assert.equal(text.includes('QUERYSECRET-9f3a'), false, route);
        }
      }

      const hidden = await fetch(`${base}/.hidden-probe`, { headers: { accept: 'text/html' } });
      const hiddenText = await hidden.text();
      assert.equal(hidden.status, 404);
      assert.match(hidden.headers.get('content-type') || '', /text\/html/);
      assert.equal(hiddenText.includes(marker), false);
      assert.match(hiddenText, /<title>Not found<\/title>/);

      const asset = await fetch(`${base}/assets/.hidden`);
      const assetText = await asset.text();
      assert.equal(asset.status, 404);
      assert.equal(assetText.includes(marker), false);

      const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      assert.equal(home.status, 200);
      assert.ok((await home.text()).includes(`${marker}-spa`));

      const unknown = await fetch(`${base}/no-such-page`, { headers: { accept: 'text/html' } });
      const unknownText = await unknown.text();
      assert.equal(unknown.status, 404);
      assert.match(unknown.headers.get('content-type') || '', /text\/html/);
      assert.match(unknownText, /<title>Not found<\/title>/);
      assert.equal(unknownText.includes(`${marker}-spa`), false);
    });
  } finally {
    restore();
  }
});

test('the app, privacy page, and deploy notes describe the aggregate', () => {
  const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  assert.match(app, /navigator\.sendBeacon\('\/api\/event', body\)/);
  assert.match(app, /if \(!isPlaying \|\| readerCounted\.current\) return;/);
  assert.match(app, /reportEvent\('reader_started'\)/);
  const claim = app.slice(app.indexOf("params.get('session_id')"), app.indexOf('const pack = packFromBuy'));
  assert.match(claim, /reportEvent\('summary_purchased'\)/);
  assert.equal(claim.includes('reader_started'), false);
  assert.match(app, /readerCounted\.current = false/);

  const privacy = fs.readFileSync(path.resolve('public/privacy/index.html'), 'utf8');
  assert.match(privacy, /cookieloze, geaggregeerde statistiek/);
  assert.match(privacy, /geen IP-adres/);
  assert.match(privacy, /pad-groep/);
  assert.equal(privacy.toLowerCase().includes('anonymous'), false);

  const deploy = fs.readFileSync(path.resolve('DEPLOY.md'), 'utf8');
  assert.match(deploy, /gcloud logging read 'resource\.type="cloud_run_revision" AND resource\.labels\.service_name="speedreader-pro" AND jsonPayload\.type="sr_lang_agg"'/);
  assert.match(deploy, /CF_BEACON_TOKEN/);
  assert.match(deploy, /POST \/api\/event` allows 600 requests per minute per process/);

  const httpSource = fs.readFileSync(path.resolve('lib/http.js'), 'utf8');
  assert.equal((httpSource.match(/dotfiles: 'ignore'/g) || []).length, 2);
  assert.match(httpSource, /limiters\.event\.allow\('event'\)/);
  assert.match(httpSource, /process\.once\('SIGTERM'/);
  assert.match(httpSource, /app\.flushLangAgg\(\)/);
});
