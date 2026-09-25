import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { applyCompanyMarkup } from './lib/company.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const INTENT_REWRITES: Record<string, string> = {
    rsvp: 'rsvp',
    'ai-summary': 'ai-summary',
    'for-builders': 'for-builders',
    'read-long-pdf': 'read-long-pdf',
    privacy: 'privacy',
    'rsvp-reading': 'rsvp',
};

function fillBuiltHtml(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) fillBuiltHtml(full);
        else if (entry.name.endsWith('.html')) {
            const raw = fs.readFileSync(full, 'utf8');
            const next = applyCompanyMarkup(raw);
            if (next !== raw) fs.writeFileSync(full, next);
        }
    }
}

/** Serve public/<slug>/index.html at /<slug>, with the shared company line filled in. */
function intentLandingPages() {
    let outDir = '';
    const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const raw = req.url ?? '';
        const [pathname] = raw.split('?');
        const slug = pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\/index\.html$/, '');
        const folder = INTENT_REWRITES[slug];
        if (!folder) {
            next();
            return;
        }
        const file = path.join(rootDir, 'public', folder, 'index.html');
        if (!fs.existsSync(file)) {
            next();
            return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(applyCompanyMarkup(fs.readFileSync(file, 'utf8')));
    };
    return {
        name: 'intent-landing-pages',
        configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
            server.middlewares.use(serve);
        },
        configurePreviewServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
            server.middlewares.use(serve);
        },
        configResolved(config: { root: string; build: { outDir: string } }) {
            outDir = path.resolve(config.root, config.build.outDir);
        },
        closeBundle() {
            fillBuiltHtml(outDir);
        },
    };
}

export default defineConfig(() => {
    return {
      // No catch-all to index.html — this app has no client router; landings are real HTML.
      appType: 'mpa',
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:8080',
            changeOrigin: true,
          },
        },
      },
      plugins: [react(), intentLandingPages()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
