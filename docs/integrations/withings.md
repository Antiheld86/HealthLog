# Withings integration

HealthLog connects to Withings via OAuth2 plus a push webhook for
near-real-time sync. Once linked, every Body+ scale weighing, BPM
blood-pressure reading, ScanWatch sleep stage, and activity sample
lands in HealthLog within seconds — no polling, no third-party
relay.

## What gets synced

The Withings client (`src/lib/withings/client.ts`) maps the following
metric types into `Measurement` rows tagged `source = WITHINGS`:

| Withings meastype                                                                                                                              | HealthLog `MeasurementType`                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1                                                                                                                                              | `WEIGHT`                                            |
| 5                                                                                                                                              | `FAT_FREE_MASS`                                     |
| 9                                                                                                                                              | `BLOOD_PRESSURE_DIA`                                |
| 10                                                                                                                                             | `BLOOD_PRESSURE_SYS`                                |
| 11                                                                                                                                             | `PULSE`                                             |
| 54, 35                                                                                                                                         | `OXYGEN_SATURATION` (ScanWatch / pulse-ox products) |
| Plus the body-composition family (fat ratio, muscle mass, bone mass, hydration) and sleep / heart-rate variability via the heart-list endpoint |

Activity data (steps, active energy, distance, floors climbed) lands
via the `user.activity` OAuth scope shipped in v1.4.25. Sleep stages
arrive via the sleep series endpoint.

## 1. Register a Withings developer app

1. Sign in at <https://developer.withings.com/> and **create a new
   public-API application**. The "Public" tier is free and supports
   the OAuth2 flow HealthLog uses; you do not need the partner tier.
2. **Callback URL:** `https://your-instance.example.com/api/withings/callback`.
   Withings allows multiple callbacks per app — add one entry per
   environment (production, staging, local development against a
   tunnel).
3. **Scopes:** request `user.metrics` AND `user.activity`. Both are
   needed — `user.metrics` covers weight / BP / heart-list / sleep /
   SpO₂ / body comp / temperature / VO₂ max; `user.activity` is the
   workout-equivalent stream for steps / energy / distance / floors.
   See `WITHINGS_OAUTH_SCOPE` in `src/lib/withings/client.ts`.
4. Save the application. Withings will issue a **Client ID** and a
   **Client Secret** — keep the secret out of any chat log; it grants
   read access to every linked account's full health history.

## 2. Wire the credentials in Settings → Integrations

Withings credentials are stored per user, not in `.env`. Sign in as
the target user, open **Settings → Integrations → Withings**, and
paste the client ID and secret. They are encrypted AES-256-GCM at
rest (`src/lib/withings/credentials.ts`). On a shared instance every
user brings their own Withings app credentials; there is no
server-level client-id/secret fallback.

Two server-level env vars remain:

```env
WITHINGS_WEBHOOK_SECRET="$(openssl rand -hex 32)"
WITHINGS_REDIRECT_URI="https://your-instance.example.com/api/withings/callback"
```

`WITHINGS_WEBHOOK_SECRET` is the path-segment token the webhook
handler validates against. Generate a fresh random value — anything
that fits in a URL path segment works, but a 64-character hex string
keeps it indistinguishable from random. Restart the `app` container
after saving.

`WITHINGS_REDIRECT_URI` is optional — when unset the callback URL
defaults to `${NEXT_PUBLIC_APP_URL}/api/withings/callback`. Set it
only when the OAuth callback must differ from that default.

## 3. Set the webhook URL

When HealthLog calls Withings `Notify.subscribe()` for a newly-linked
account, it hands Withings the callback URL constructed by
`getWithingsWebhookCallbackUrl()` (`src/lib/withings/sync.ts`).
The shape is:

```
https://your-instance.example.com/api/withings/webhook/<WITHINGS_WEBHOOK_SECRET>
```

Withings has no facility for adding HTTP headers or signing webhook
bodies, so the callback URL itself is the only authenticity surface
a subscriber controls. The v1.4.25 W17a migration moved the secret
from a query parameter (`?secret=…`, captured by every reverse-proxy
access log) to a path segment, which keeps it out of the
`query_string` column most proxies log by default
(`src/app/api/withings/webhook/[token]/route.ts:13-23`).

You do not need to register the webhook URL anywhere in the
developer portal — HealthLog subscribes per-user during the OAuth
callback. The portal only owns the OAuth callback URL.

## 4. Link from the Settings page

With the credentials saved in Settings, open
`/settings/integrations/withings` and click **Connect Withings**. The flow:

1. The Connect button redirects to Withings' `oauth2/authorize`.
2. The user signs in on Withings and grants the requested scopes.
3. Withings redirects back to `/api/withings/callback` with an auth
   code.
4. HealthLog exchanges the code for an access + refresh token, stores
   them AES-256-GCM-encrypted at rest, subscribes the webhook URL,
   and triggers an initial sync of the past 30 days.
5. The settings page now shows **Connected** with the timestamp of
   the last successful sync.

Subsequent syncs run automatically on every webhook delivery plus an
hourly safety-net cron pull (measurements at :00, sleep at :15, ECG
at :41).

## Source-priority interaction

HealthLog's source ladder ranks **WITHINGS ≻ APPLE_HEALTH ≻ MANUAL**
for point measurements (weight, BP, pulse, body fat, body
temperature, SpO₂, VO₂ max) and **APPLE_HEALTH ≻ WITHINGS ≻ MANUAL**
for cumulative metrics (steps, active energy, distance, flights,
sleep, HRV, resting HR). The defaults live in
`DEFAULT_SOURCE_PRIORITY` in `src/lib/validations/source-priority.ts`.

Concrete consequences if you run Withings alongside an Apple Health
import:

- Weight readings from a Withings scale win for display. Apple
  Health rows for the same metric (received second-hand from Health
  Mate) stay in the DB as audit trail but drop out of the active
  display.
- Steps from a ScanWatch go through HealthKit's daily aggregation
  when Apple Health is also linked, so the Apple Health stream wins
  for the cumulative axis. The Withings rows stay in the DB.

Override per-user via Settings → Sources (`/settings/sources`).

## Troubleshooting

### The Connect button errors out

- **`Withings credentials not configured`** — the signed-in user has
  not saved a client ID + secret under **Settings → Integrations →
  Withings**. Credentials live per user in the database, not in
  `.env` — paste the pair from the developer portal and retry.
- **`Callback URI mismatch`** — the URL HealthLog sends to Withings
  must match an entry in the developer-portal app's callback list.
  Add the public URL exactly, including the `https://` scheme and
  the `/api/withings/callback` path.

### The webhook stops firing

Webhook subscriptions can lapse after a token revoke or a portal-
side cleanup. Re-subscribe by opening `/settings/integrations/withings`
and clicking **Disconnect** then **Connect Withings** again — the
callback exchange re-runs `Notify.subscribe()` with a fresh callback
URL.

Test the inbound path with a HEAD request from outside the host:

```bash
curl -I https://your-instance.example.com/api/withings/webhook/<WITHINGS_WEBHOOK_SECRET>
```

A `200 OK` means the path-segment secret matches. A `401` means the
env var on the running container does not match the secret embedded
in the URL Withings was handed at subscribe time. Re-subscribing
fixes the mismatch by updating the URL Withings holds.

### Sync is stuck on "Reauthorisation required"

Withings revokes refresh tokens on password change, app un-authorise,
or after extended inactivity. The `WithingsConnection` row flips to
`error_reauth` status and the scheduled sync no-ops until the user
re-runs the OAuth flow (`src/lib/withings/sync.ts`).
Click **Connect Withings** again from the settings page; the
callback exchanges fresh tokens and the next sync runs through the
last 30 days of history to catch up.

### Disconnect cleanly

The Settings page **Disconnect** button:

1. Calls `POST /api/withings/disconnect`.
2. Server-side: unsubscribes the webhook categories (best-effort
   Withings `Notify` revoke per category), deletes the
   `WithingsConnection` row with its stored encrypted tokens, and
   audits the action. The Withings-side grant itself persists until
   the user un-authorises HealthLog in their Withings account.
3. Existing `Measurement` rows tagged `source = WITHINGS` stay in
   the database — disconnect does not delete data. Re-linking the
   same Withings account merges back onto the same metric
   timeline; the upsert path matches on `(userId, type, measuredAt,
source)` so previously-synced rows update in place.

## Connection test

`POST /api/integrations/withings/test` runs a read-only round-trip
against the calling user's own stored credentials and returns the
latency in milliseconds (rate-limited to 5/min per user). The
Withings settings card surfaces it as the connection test. Use it
when data looks stale — a green test plus a stale `lastSyncedAt`
usually means the webhook URL Withings holds is out of sync
(re-subscribe per the steps above).
