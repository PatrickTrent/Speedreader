<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Speedreader

RSVP reader. AI summaries and credit purchases go through the Node server. See [DEPLOY.md](DEPLOY.md) for production.

## Run locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Put the server environment in the shell or in `.env` loaded by your process manager. Required for a full run:
   - `GEMINI_API_KEY` — Gemini, server only. Do not expose it to the browser.
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_STARTER` — Price id for 5 credits at €0,99
   - `STRIPE_PRICE_PRO` — Price id for 50 credits at €3,99
   - `DATA_DIR` — persistent directory for `wallets.sqlite`, outside the deploy directory in production
   - `IP_HASH_SECRET` — server-side salt for the free-grant IP hash (required in production)
3. Use Node.js 22.13 or newer. Build and start: `npm run build && npm start` (`npm start` sets `NODE_ENV=production`).

The site listens on `PORT` (default 8080). Stripe webhook URL: `https://speedreader.nl/api/stripe-webhook` (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`).

`npm run dev` is the UI only, with `/api` proxied to port 8080.

`npm test` checks claims, config gating, refunds, ignored webhooks, client IP handling, and that a Vite build does not contain a fake Gemini key.
