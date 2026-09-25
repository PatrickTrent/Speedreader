# Deploy Speedreader

Production is one Node process:

```bash
npm install
npm run build
NODE_ENV=production DATA_DIR=/var/lib/speedreader IP_HASH_SECRET="$(openssl rand -hex 32)" npm start
```

Node.js 22.13 or newer is required (`node:sqlite`). `.nvmrc` says `22`, and `package.json` sets `"engines": {"node": ">=22.13"}`. `server.js` checks the version and exits before it loads `node:sqlite` if Node is older.

`npm start` runs `NODE_ENV=production node server.js`. Anything other than `NODE_ENV=development` or `NODE_ENV=test` is treated as production. The process serves `dist/` and the credit API.

## Data directory

Balances, claims, and the free-grant log live in SQLite: `$DATA_DIR/wallets.sqlite` (WAL mode).

`DATA_DIR` is required in production (any `NODE_ENV` other than `development` or `test`). The process refuses to start if it is unset, or if the path — after `mkdir` and `realpath` — sits inside the app directory or the current working directory, including when a symlink points there. Point it at a persistent volume **outside** the deploy directory, so a new release does not wipe wallets. One process only: a second Node process on the same file can lose updates. Do not run more than one `server.js` against the same `DATA_DIR`.

If the directory cannot be created, or the database cannot be opened or is corrupt, the process does not crash. It logs `WALLET DATABASE FAILED. Payments and summaries are disabled.` and keeps serving the site. `GET /api/config` then returns `{ "payments": false, "summaries": false }`. Payments stay off until the file is restored. Nothing is charged while checkout is off.

Backup (stop writes, or use SQLite’s online backup):

```bash
sqlite3 "$DATA_DIR/wallets.sqlite" ".backup '${DATA_DIR}/wallets.sqlite.bak'"
```

A timer (hourly, and it does not keep the process alive by itself) deletes free-only wallets with no payment and no claim after 180 days without activity, deletes free-grant hashes older than 24 hours, and deletes paid wallets after 3 years without activity only when the balance is 0 and every claim on that wallet is older than 180 days (the dispute window). Claims older than 7 years are replaced by a tombstone: the Stripe session id and a claimed flag, with no wallet id and no amounts. The session id is pseudonymous data, because Stripe can link it to the cardholder. Tombstones are kept indefinitely so the same payment cannot be credited twice. Adjustment rows older than 7 years are deleted in the same pass. A wallet with a balance above 0 is never deleted. The cleanup does not run inside a request.

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
| `TRUST_CLOUDFLARE` | no | `1` may read `CF-Connecting-IP`. `0` always uses the socket address. When unset, production (everything except `development` and `test`) defaults to `1`. |
| `ORIGIN_SECRET` | required in production unless `DIRECT_CLOUDFLARE_ORIGIN=1` | Shared secret checked against `X-Origin-Secret`. Trimmed once at startup; that trimmed value is what every comparison uses. In production it must be at least 32 characters or the process refuses to start. On Cloud Run, App Engine, or behind a Google load balancer, `ORIGIN_SECRET` plus a Cloudflare Transform Rule are required. The rule must use Set, not Add, for the `X-Origin-Secret` request header. When the secret is set, `CF-Connecting-IP` is trusted only if the header matches, whatever the TCP peer is. Also required for `TRUST_FORWARDED_FROM=google`. |
| `DIRECT_CLOUDFLARE_ORIGIN` | required in production when `ORIGIN_SECRET` is unset | Set to `1` only for a VM that Cloudflare connects to directly. Production refuses to start when `ORIGIN_SECRET` is unset and this is not `1`. |
| `TRUST_FORWARDED_FROM` | no | Set to `google` to trust the last untrusted hop of `X-Forwarded-For` when the TCP peer is in the Google ranges (`35.191.0.0/16`, `130.211.0.0/22`, or the Cloud Run peer `169.254.0.0/16`) and `ORIGIN_SECRET` matches. |
| `NODE_ENV` | set by `npm start` | `production` is the default for `npm start`. `development` and `test` are the only non-production values. Production refuses to start without `DATA_DIR`, `IP_HASH_SECRET`, and either `ORIGIN_SECRET` or `DIRECT_CLOUDFLARE_ORIGIN=1`. Error responses omit stack traces. |

`GET /api/config` returns `{ "payments": true/false, "summaries": true/false }`. Payments are on only when the database is open, the Stripe secret is set, and both price ids are set. Summaries are on only when the database is open and `GEMINI_API_KEY` is set. The buy buttons and the summary button follow that response.

There is no account system. The browser keeps a random wallet id in `localStorage` under `walletId`. The id is sent in the `X-Wallet-Id` header (and, for checkout, claim, and summarize, also in the JSON body). It is never put in a URL or query string. `GET /api/wallet` reads that header and does not create a row. The row is created on the first successful free summary (2 credits, then one is spent) or on a verified payment. Each connection can receive at most 5 free grants per rolling 24 hours. The cap key is an HMAC-SHA256 of the IP (IPv6 grouped to /64) with `IP_HASH_SECRET`. The raw IP is not stored.

`POST /api/summarize` accepts JSON up to 512kb, sends at most the first 35,000 characters to Gemini, and allows 20 summary requests per IP per 10 minutes. The Gemini call is aborted after 60 seconds and the reserved credit is refunded. One credit is taken only when a summary comes back. A missing key returns “Summaries are temporarily unavailable”.

Every `/api` response sends `Cache-Control: no-store` and no `ETag`. The `/api` router is case sensitive and strict, so `/API/wallet` and `/api/wallet/` do not reach the handlers. Header checks still lowercase the path and strip a trailing slash, so those requests get the same cache headers. `/api/wallet`, `/api/checkout`, `/api/claim`, and `/api/summarize` also send `Vary: X-Wallet-Id`. Hashed files under `/assets/` send `Cache-Control: public, max-age=31536000, immutable`.

Every `/api` route except the case below is rate limited, per IP, in memory. Old entries are dropped on a timer. The counters live for minutes and are cleared on restart. Limits: `GET /api/config` 600 per minute, wallet reads 60 per minute, checkout 10 per 10 minutes, claim 30 per 10 minutes, summarize 20 per 10 minutes. `POST /api/stripe-webhook` allows 1000 per minute so a Stripe burst is not blocked. If the TCP peer is neither Cloudflare nor loopback and `ORIGIN_SECRET` is unset, `/api/config` is not rate limited, so a shared Google address cannot lock every visitor out of the buttons. A peer in `169.254.0.0/16` or a Google load balancer range with `ORIGIN_SECRET` unset gets `503` `origin_misconfigured` on `/api/wallet`, `/api/checkout`, `/api/claim`, and `/api/summarize`, and those requests are not placed in a shared rate-limit bucket. `GET /api/config` for that peer returns `{ "payments": false, "summaries": false }`. The browser treats a 429 or a failed config request as unknown and leaves the buy and summary buttons enabled. Checkout still decides.

Logs that mention a wallet use an 8-character hash of the id, not the id itself. The wallet id is never put in a request URL, so hosting and CDN logs of the URL do not contain it. Hosting logs are kept for at most 30 days.

## Client IP

### VM directly behind Cloudflare

The TCP peer is a Cloudflare address. Set `DIRECT_CLOUDFLARE_ORIGIN=1`. `ORIGIN_SECRET` may stay unset. With `TRUST_CLOUDFLARE=1` (the production default) the server uses `CF-Connecting-IP` only when that peer is inside the ranges hardcoded in `lib/cloudflare-ips.js` (copied from [ips-v4](https://www.cloudflare.com/ips-v4) and [ips-v6](https://www.cloudflare.com/ips-v6); update that file when Cloudflare publishes new ranges). Lock the origin firewall to those ranges. `X-Forwarded-For` is not used.

### Cloud Run, App Engine, or a Google load balancer

On Cloud Run, App Engine, or behind a Google load balancer, `ORIGIN_SECRET` plus a Cloudflare Transform Rule are required. The TCP peer is a Google address (`35.191.0.0/16` or `130.211.0.0/22` in `lib/google-frontend-ips.js`) or the Cloud Run link-local peer `169.254.0.0/16`, not Cloudflare, because Google’s frontend sits between Cloudflare and the process. The Transform Rule must use Set, not Add, for the `X-Origin-Secret` request header, with the same value as `ORIGIN_SECRET`. Then `CF-Connecting-IP` is trusted when that header matches, whatever the peer is.

Recognizing `169.254.0.0/16` does not trust forwarded headers by itself. Do not set `DIRECT_CLOUDFLARE_ORIGIN=1` on Cloud Run, App Engine, or behind a Google load balancer. If a request arrives from `169.254.0.0/16` or a Google load balancer range and `ORIGIN_SECRET` is unset, the process logs that once and `/api/wallet`, `/api/checkout`, `/api/claim`, and `/api/summarize` return `503` `origin_misconfigured`. Those requests are not placed in a shared rate-limit bucket. `X-Forwarded-For` and `CF-Connecting-IP` are ignored.

If the Transform Rule does not preserve `CF-Connecting-IP`, set `TRUST_FORWARDED_FROM=google` as well. The server then reads `X-Forwarded-For` only when the peer is in those ranges (including `169.254.0.0/16`) and the origin secret matches. It keeps the last hop that is not itself a Cloudflare or Google address.

### Neither of those

Production refuses to start unless `ORIGIN_SECRET` is set or `DIRECT_CLOUDFLARE_ORIGIN=1` is set. If the peer is neither Cloudflare nor loopback and `ORIGIN_SECRET` is unset, the first such request logs `UNTRUSTED PEER`. Forwarded headers are ignored. `/api/config` does not apply a shared rate-limit bucket for that peer. A peer in `169.254.0.0/16` or a Google load balancer range instead gets `503` `origin_misconfigured` on the credit routes above. Set `ORIGIN_SECRET` before relying on client IPs.

An invalid `CF-Connecting-IP` falls back to the socket address. IPv6 clients are grouped by /64 before rate limits and the free-grant HMAC. `TRUST_CLOUDFLARE=0` always uses the socket address.

## Stripe Dashboard

Copy the Price id for each pack (the public Payment Link pages do not include them):

- Starter, €0,99 (99 cents), 5 credits → `STRIPE_PRICE_STARTER`
- Pro, €3,99 (399 cents), 50 credits → `STRIPE_PRICE_PRO`

Create a webhook endpoint:

- URL: `https://speedreader.nl/api/stripe-webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`
- Put the signing secret in `STRIPE_WEBHOOK_SECRET`

A bad signature is the only webhook case that returns HTTP 400. Events the server deliberately skips (unknown type, unknown price, missing wallet, unpaid or invalid session, a session Stripe does not know, a session older than 30 days) return HTTP 200 so Stripe does not retry them. `POST /api/claim` returns 400 `session_not_found` when Stripe answers `resource_missing` for that `cs_` id, and 400 `session_expired` when the session is older than 30 days. If Stripe cannot be reached, or the database errors while crediting or refunding, the webhook returns HTTP 500 so Stripe retries. A refund deducts `floor(credits_bought * amount_refunded / amount_total)`. The stored number is that target, not the credits the balance could actually give up, so a replay deducts 0 even if the wallet was empty and was topped up later. Credits are removed for `charge.dispute.created` and `charge.dispute.funds_withdrawn` only when the status is a real dispute (`needs_response`, `under_review`, `lost`, `charge_refunded`), not for `warning_needs_response`. `won` and `warning_closed` restore the credits that were actually removed, once. Refund room subtracts only the credits an open dispute is still holding, so a full refund after `won` or `warning_closed` still removes the restored credits. The dispute target stays recorded, so a replay of the dispute event does not deduct again. A refund or dispute that arrives before the claim is stored against the payment intent and charge; the later claim adds only the net credits, or nothing if the payment was fully refunded. After 7 years the claim row is replaced by a tombstone so the same session cannot be credited again.

Checkout Sessions are created only by `POST /api/checkout`. There is no Payment Link fallback. If checkout cannot start, the app says “Payment is temporarily unavailable, you have not been charged” and does not redirect. Sessions allow `card`, `ideal`, and `bancontact` (instant methods). `checkout.session.async_payment_succeeded` is still credited the same way as a paid `checkout.session.completed`, in case a delayed method is added later.

The success URL is fixed in the server:

`https://speedreader.nl/?session_id={CHECKOUT_SESSION_ID}`

The browser then calls `POST /api/claim`. The webhook credits the same session if the browser never calls claim. A session is credited once. A claim whose wallet id does not match the session still credits the wallet that started checkout, and tells the other browser to open the original one or email `speedreader@agentmail.to` with the Stripe receipt.

A refund or dispute (`charge.refunded`, `charge.dispute.created`) subtracts the purchased credits from the linked wallet. The balance stops at 0. The charge id and payment intent are stored on the claim so the events can be matched. Reversal is idempotent.

A paid session is accepted only when it has exactly one line item, quantity 1, currency `eur`, and `amount_total` equal to `STRIPE_AMOUNT_STARTER` or `STRIPE_AMOUNT_PRO`.

Intent pages link to `/#reader` or `/?buy=starter` / `/?buy=pro`. A buy link opens the pack choice with that pack pre-selected. Checkout starts only after the visitor presses the button, and only through `POST /api/checkout`.

In the Dashboard, remove any Payment Link success URL that adds `?success=true&credits=N`. The site ignores those parameters and does not send buyers to Payment Links.

`GEMINI_API_KEY` must be present in the server environment. It must not be passed into the Vite build as a client `define`. The build does not read it.

## Local UI

`npm run dev` serves the UI on port 3000 and proxies `/api` to `http://127.0.0.1:8080`. Run `npm run build && npm start` in another terminal for the API. Outside production, `DATA_DIR` defaults to `./data` next to `server.js`. Set `IP_HASH_SECRET` if you want free-grant hashes to survive a restart.

## Tests

```bash
npm test
```

The bundle test runs a Vite build with a unique fake `GEMINI_API_KEY` and fails if that value, the name `GEMINI_API_KEY`, or `generativelanguage` appears in the output.
