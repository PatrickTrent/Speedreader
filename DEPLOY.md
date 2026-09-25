# Deploy Speedreader

Production is one Node process:

```bash
npm install
npm run build
npm start
```

`npm start` runs `server.js` (Express). It serves `dist/` and the credit API. The old Flask file `server.py` does not grant credits.

Balances live in a JSON file, `wallets.json`, inside `DATA_DIR`. Use one process for that directory. A second process writing the same file can lose updates. Put `DATA_DIR` on a disk that survives restarts.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes, for summaries | Gemini key. Read only on the server. It is not injected into the client bundle. |
| `STRIPE_SECRET_KEY` | yes, for checkout | Stripe secret key (`sk_live_...` or `sk_test_...`). |
| `STRIPE_WEBHOOK_SECRET` | yes, for the webhook | Signing secret for `POST /api/stripe-webhook` (`whsec_...`). |
| `STRIPE_PRICE_STARTER` | yes, for the €0,99 pack | Stripe Price id for Starter: 5 credits. |
| `STRIPE_PRICE_PRO` | yes, for the €3,99 pack | Stripe Price id for Pro: 50 credits. |
| `DATA_DIR` | recommended | Directory for `wallets.json`. Default is `./data` next to `server.js`. |
| `PORT` | no | Listen port. Default `8080`. |
| `TRUST_PROXY` | no | Default trusts one proxy hop so per-IP limits see the visitor. Set `TRUST_PROXY=0` only when Node is reached directly, with no reverse proxy. |

There is no account system. The browser keeps a random wallet id in `localStorage` under `walletId`. The server stores the balance for that id. A new wallet gets 2 credits once. Each connection can open at most 5 free wallets per UTC day; wallets after that start at 0 and can still be topped up by a verified payment.

`POST /api/summarize` accepts JSON up to 512kb, sends at most the first 35,000 characters to Gemini, and allows 20 summary requests per IP per 10 minutes. One credit is taken only when a summary comes back. A failed call is refunded.

## Stripe Dashboard

The public Payment Links do not include their Price ids. In the Dashboard, open each Payment Link (or the product behind it) and copy the Price id:

- Starter, €0,99, 5 credits → `STRIPE_PRICE_STARTER`
- Pro, €3,99, 50 credits → `STRIPE_PRICE_PRO`

Create a webhook endpoint:

- URL: `https://speedreader.nl/api/stripe-webhook`
- Event: `checkout.session.completed`
- Put the signing secret in `STRIPE_WEBHOOK_SECRET`

Checkout Sessions are created by `POST /api/checkout`. The success URL is fixed in the server:

`https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}`

The browser then calls `POST /api/claim`. The webhook credits the same session if the browser never calls claim. A session is credited once.

Payment Links stay in the app only as a fallback when `POST /api/checkout` cannot start a session (missing key or price id, or Stripe errors). A Payment Link purchase is not credited. In the Dashboard, remove any success URL on those links that adds `?success=true&credits=N`. The site ignores those parameters.

`GEMINI_API_KEY` must be present in the server environment. It must not be passed into the Vite build as a client `define`. The build does not read it.

## Local UI

`npm run dev` serves the UI on port 3000 and proxies `/api` to `http://127.0.0.1:8080`. Run `npm run build && npm start` in another terminal for the API.

## Tests

```bash
npm run build
npm test
```

The bundle test reads `dist/` and fails if `GEMINI_API_KEY` or `generativelanguage` appears there.
