import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, 'dist');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing. Run npm run build before npm start.');
  process.exit(1);
}

const app = express();

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

// Intent HTML and the legacy redirect, before static files and the app fallback.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const clean = req.path.replace(/\/+$/, '') || '/';
  if (clean === '/rsvp-reading') {
    return res.redirect(301, '/rsvp');
  }
  const file = intentPage(req.path);
  if (file) return res.sendFile(file);
  next();
});

// /intent.css, /robots.txt, /sitemap.xml, /rsvp/index.html, hashed assets.
app.use(express.static(distDir, { index: false, redirect: false }));

// App shell for /. Unknown paths fall through to the same document.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Speedreader listening on ${port}`);
});
