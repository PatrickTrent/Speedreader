# Deploy Speedreader

Production is one Node process:

```bash
npm install
npm run build
DATA_DIR=/var/lib/speedreader IP_HASH_SECRET="$(openssl rand -hex 32)" npm start
```

`npm start` runs `server.js` (Express). It serves `dist/` and the credit API. The old Flask file `server.py` does not grant credits.

## Data directory

Balances, claims, and the free-grant log live in SQLite: `$DATA_DIR/wallets.sqlite` (WAL mode).

`DATA_DIR` is required when `NODE_ENV=production`. The process refuses to start if it is unset, or if it sits inside the app directory or the current working directory. Point it at a persistent volume **outside** the deploy directory, so a new release does not wipe wallets. One process only: a second Node process on the same file can lose updates. Do not run more than one `server.js` against the same `DATA_DIR`.

If the database cannot be opened or is corrupt, the process logs `WALLET DATABASE FAILED. Payments and summaries are disabled.` and keeps serving the site. `GET /api/config` then returns `{ "payments": false, "summaries": false }`. Payments stay off until the file is restored. Nothing is charged while checkout is off.

Backup (stop writes, or use SQLite’s online backup):

```bash
sqlite3 "$DATA_DIR/wallets.sqlite" ".backup '${DATA_DIR}/wallets.sqlite.bak'"
```

Free-only wallets with no payment and no claim are deleted after 180 days without activity. Paid wallets and claim rows are never deleted by that job. Claims and payment records are kept for 7 years (tax).

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes, for summaries | Gemini key. Read only on the server. It is not injected into the client bundle. |
| `STRIPE_SECRET_KEY` | yes, for checkout | Stripe secret key (`sk_live_...` or `sk_test_...`). |
| `STRIPE_WEBHOOK_SECRET` | yes, for the webhook | Signing secret for `POST /api/stripe-webhook` (`whsec_...`). |
| `STRIPE_PRICE_STARTER` | yes, for the €0,99 pack | Stripe Price id for Starter: 5 credits. |
| `STRIPE_PRICE_PRO` | yes, for the €3,99 pack | Stripe Price id for Pro: 50 credits. |
| `STRIPE_AMOUNT_STARTER` | no | Expected charge in euro cents. Default `99`. |
| `STRIPE_AMOUNT_PRO` | no | Expected charge in euro cents. Default `399`. |
| `DATA_DIR` | required in production | Persistent directory for `wallets.sqlite`, outside the deploy directory. |
| `IP_HASH_SECRET` | required in production | Secret salt for the HMAC of the client IP used by the free-grant cap. The hash is kept at most 24 hours. |
| `PORT` | no | Listen port. Default `8080`. |
| `TRUST_CLOUDFLARE` | no | `1` reads `CF-Connecting-IP`. `0` uses the socket address. When unset, production defaults to `1` and any other `NODE_ENV` defaults to `0`. |
| `NODE_ENV` | yes, in production | `production` refuses to start without `DATA_DIR` and `IP_HASH_SECRET`, and error responses omit stack traces. |

`GET /api/config` returns `{ "payments": true/false, "summaries": true/false }`. Payments are on only when the database is open, the Stripe secret is set, and both price ids are set. Summaries are on only when the database is open and `GEMINI_API_KEY` is set. The buy buttons and the summary button follow that response.

There is no account system. The browser keeps a random wallet id in `localStorage` under `walletId`. `GET /api/wallet` does not create a row. The row is created on the first successful free summary (2 credits, then one is spent) or on a verified payment. Each connection can receive at most 5 free grants per rolling 24 hours. The cap key is an HMAC-SHA256 of the IP (IPv6 grouped to /64) with `IP_HASH_SECRET`. The raw IP is not stored.

`POST /api/summarize` accepts JSON up to 512kb, sends at most the first 35,000 characters to Gemini, and allows 20 summary requests per IP per 10 minutes. The Gemini call is aborted after 60 seconds and the reserved credit is refunded. One credit is taken only when a summary comes back. A missing key returns “Summaries are temporarily unavailable”.

Other limits, per IP, in memory, with periodic cleanup of old entries: wallet reads 60 per minute, checkout 10 per 10 minutes, claim 30 per 10 minutes.

## Client IP

The server never reads `X-Forwarded-For`. With `TRUST_CLOUDFLARE=1` it uses `CF-Connecting-IP` (otherwise the TCP socket address). That header is only trustworthy if the origin accepts connections from Cloudflare’s IP ranges and rejects everyone else. Lock the origin firewall or load balancer to [Cloudflare’s published IPs](https://www.cloudflare.com/ips/). IPv6 clients are grouped by /64 before rate limits and the free-grant HMAC.

## Stripe Dashboard

Copy the Price id for each pack (the public Payment Link pages do not include them):

- Starter, €0,99 (99 cents), 5 credits → `STRIPE_PRICE_STARTER`
- Pro, €3,99 (399 cents), 50 credits → `STRIPE_PRICE_PRO`

Create a webhook endpoint:

- URL: `https://speedreader.nl/api/stripe-webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`
- Put the signing secret in `STRIPE_WEBHOOK_SECRET`

A bad signature is the only case that returns HTTP 400. Events the server deliberately skips (unknown type, unknown price, missing wallet, unpaid session) return HTTP 200 so Stripe does not retry them. A database failure during credit grant returns HTTP 500 so Stripe retries.

Checkout Sessions are created only by `POST /api/checkout`. There is no Payment Link fallback. If checkout cannot start, the app says “Payment is temporarily unavailable, you have not been charged” and does not redirect. Sessions allow `card`, `ideal`, and `bancontact` (instant methods). `checkout.session.async_payment_succeeded` is still credited the same way as a paid `checkout.session.completed`, in case a delayed method is added later.

The success URL is fixed in the server:

`https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}`

The browser then calls `POST /api/claim`. The webhook credits the same session if the browser never calls claim. A session is credited once. A claim whose wallet id does not match the session still credits the wallet that started checkout, and tells the other browser to open the original one or email `speedreader@agentmail.to` with the Stripe receipt.

A refund or dispute (`charge.refunded`, `charge.dispute.created`) subtracts the purchased credits from the linked wallet. The balance stops at 0. The charge id and payment intent are stored on the claim so the events can be matched. Reversal is idempotent.

A paid session is accepted only when it has exactly one line item, quantity 1, currency `eur`, and `amount_total` equal to `STRIPE_AMOUNT_STARTER` or `STRIPE_AMOUNT_PRO`.

Intent pages link to `/#reader` or `/?buy=starter` / `/?buy=pro`. The app opens checkout through `/api/checkout` only.

In the Dashboard, remove any Payment Link success URL that adds `?success=true&credits=N`. The site ignores those parameters and does not send buyers to Payment Links.

`GEMINI_API_KEY` must be present in the server environment. It must not be passed into the Vite build as a client `define`. The build does not read it.

## Local UI

`npm run dev` serves the UI on port 3000 and proxies `/api` to `http://127.0.0.1:8080`. Run `npm run build && npm start` in another terminal for the API. Outside production, `DATA_DIR` defaults to `./data` next to `server.js`. Set `IP_HASH_SECRET` if you want free-grant hashes to survive a restart.

## Tests

```bash
npm test
```

The bundle test runs a Vite build with a unique fake `GEMINI_API_KEY` and fails if that value, the name `GEMINI_API_KEY`, or `generativelanguage` appears in the output.
