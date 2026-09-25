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

// App shell only. /#reader and /#faq are hashes on this document, not paths.
// App.tsx has no other client-side routes.
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// /intent.css, /robots.txt, /sitemap.xml, /<slug>/index.html, hashed assets.
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

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Speedreader listening on ${port}`);
});
