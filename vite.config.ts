import path from 'path';
import type { IncomingMessage } from 'http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const INTENT_REWRITES: Record<string, string> = {
    rsvp: 'rsvp',
    'ai-summary': 'ai-summary',
    'for-builders': 'for-builders',
    'read-long-pdf': 'read-long-pdf',
    privacy: 'privacy',
    'rsvp-reading': 'rsvp',
};

/** Serve public/<slug>/index.html at /<slug> (Vite SPA fallback would otherwise steal these). */
function intentLandingPages() {
    const rewrite = (req: IncomingMessage) => {
        const raw = req.url ?? '';
        const [pathname, search = ''] = raw.split('?');
        const slug = pathname.replace(/^\//, '').replace(/\/$/, '');
        const folder = INTENT_REWRITES[slug];
        if (folder) {
            req.url = `/${folder}/index.html${search ? `?${search}` : ''}`;
        }
    };
    return {
        name: 'intent-landing-pages',
        configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, _res: unknown, next: () => void) => void) => void } }) {
            server.middlewares.use((req, _res, next) => {
                rewrite(req);
                next();
            });
        },
        configurePreviewServer(server: { middlewares: { use: (fn: (req: IncomingMessage, _res: unknown, next: () => void) => void) => void } }) {
            server.middlewares.use((req, _res, next) => {
                rewrite(req);
                next();
            });
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
