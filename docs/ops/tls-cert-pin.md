# TLS SPKI pinning — coupling, alarm, and re-pin runbook

The native client SPKI-pins the server's TLS chain at the **CA level**: it
ships a small pin set and rejects a connection whose validated chain
contains no pinned key. The leaf is deliberately **not** pinned, so routine
leaf renewals are a client no-op. The pin set itself and its enforcement
rules live in the client repository, not here. The outage risk is a **chain change**: the
served chain stops terminating in the pinned CA keys — the server moves to a
different CA, or the CA rotates its intermediate / root keys. This page
explains the coupling, the server-side alarm that watches the served leaf,
and the operator / release-owner steps when it fires.

## The coupling

A SPKI pin is `base64(sha256(DER subjectPublicKeyInfo))` — a hash of a
certificate's public key, not of the whole certificate. The native client
carries a set of these pins in its build-time config and rejects any TLS
connection whose validated chain contains no pinned key; the exact pin-set
rules are the client repository's contract. Self-hosted instances that ship
their own chain sit outside the pinned-host list and validate against
system trust.

The app host's certificate auto-renews roughly every 90 days and each
renewal mints a new leaf keypair. Because the client pins the CA keys rather
than the leaf, those renewals pass without a client build. What DOES break
every pinned client is a chain that no longer terminates in a pinned key —
and there is no server-side signal that clients are pinning the served chain
at all. The alarm below exists to catch exactly that early: it watches the
served **leaf**, the most frequently rotating element, as the canary for any
chain movement.

## The alarm

A scheduled job (`src/lib/jobs/tls-pin-monitor.ts`) probes the served leaf
every 6 hours and fails loudly when it changes:

- It derives the public host from `APP_URL` (falling back to
  `NEXT_PUBLIC_APP_URL`) and opens a raw TLS socket to it — observing exactly
  the certificate a pinned client would, regardless of how the reverse proxy
  terminates TLS.
- It reads the served leaf, computes its SPKI pin
  (`base64(sha256(DER subjectPublicKeyInfo))`), and compares it against the
  operator's known-good set in `TLS_LEAF_SPKI_PINS`.
- On a served pin that is **not** in the known set it emits a
  `tls.pin.leaf_changed` wide-event annotation (old set + served pin), writes
  a `system.tls.pin_changed` audit-log row, and fans out a high-priority
  `SYSTEM_ALERT` to every admin user through the notification dispatcher
  (Telegram / ntfy / Web Push / APNs, whichever the operator has wired).

A transient TLS or network failure during the probe is annotated
(`tls.pin.probe_failed`) and never alarms — the alarm fires only on a
successful probe returning a pin genuinely outside the known set.

### Baseline source: an env var, not auto-learning

`TLS_LEAF_SPKI_PINS` (comma-separated) is the known-good set of **served
leaf** pins. It is the operator's explicit record of what the server is
expected to serve — distinct from the client's CA-level pin set, which lives
in the client build config. The baseline is an env var on purpose, **not** a
persisted "last-seen" row:

- An explicit baseline forces the operator to acknowledge every leaf
  rotation and check the new chain against the client's pinned CA keys
  before the alarm goes quiet.
- A persisted last-seen baseline would silently adopt the first rotated pin
  and suppress the very alarm the pinned client needs.
- When the env var is unset, the monitor fails **loud, not open**: it logs
  the served pin (so you can seed the baseline) and warns "not configured",
  but never auto-adopts what it observed.

## Setting the baseline

Extract the current leaf SPKI pin from the served certificate:

```sh
openssl s_client -connect "$APP_HOST:443" -servername "$APP_HOST" </dev/null 2>/dev/null \
  | openssl x509 -noout -pubkey \
  | openssl pkey -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | openssl base64
```

`$APP_HOST` is the host in your configured `APP_URL` (the host the client
connects to). The output is the `base64(sha256(DER subjectPublicKeyInfo))`
pin. Set it in the deployment env:

```
TLS_LEAF_SPKI_PINS="<current-leaf-pin>"
```

The variable is on the compose `environment:` whitelist and the
`scripts/env-manifest.json` optional groups, so `pnpm check-env` will report
whether it is set. It is optional: without it the monitor still runs and logs
the served pin, but cannot alarm on a change.

## When the alarm fires

When you see a `tls.pin.leaf_changed` alert / `system.tls.pin_changed` audit
row, the served leaf has rotated. First determine which of two cases you are
in:

1. **Routine renewal, same chain.** Inspect the new chain (the `openssl`
   pipeline above, or the alert payload). If the issuing intermediate and
   root are unchanged, the client's CA-level pins still match and no client
   is at risk. Update `TLS_LEAF_SPKI_PINS` to the new served-leaf pin and
   re-deploy so the alarm goes quiet. No client build.
2. **Chain change.** The new leaf chains through a different intermediate /
   root (CA switch, or the CA rotated its keys). Every pinned client will
   stop connecting once the old chain is no longer served — run the re-pin
   procedure below inside the old chain's remaining validity, with margin
   for app review and client roll-out (the alert body and audit row carry
   the new leaf's `validTo`).

### Re-pin procedure (chain change)

1. **Extract the new chain's CA pins** (intermediate + root) with the
   `openssl` pipeline / the client repo's SPKI-extraction script.
2. **Dual-pin.** Add the new CA pins to the client's pin set **alongside**
   the old ones (do not replace them yet). Clients on the old build keep
   working as long as the old chain is still served; the dual-pinned build
   works against both chains. Update `TLS_LEAF_SPKI_PINS` to the currently
   served leaf pin(s) so the server-side alarm reflects reality.
3. **Ship the client build** carrying the dual-pin set to TestFlight (and
   onward to release). Give it long enough to roll out to the installed
   base before the old chain disappears.
4. **Retire the old pins** once the old chain is no longer served and the
   dual-pinned client build has reached the installed base.

CA-level pins move rarely — intermediates and roots carry multi-year
lifetimes and rotations are announced well ahead. Track the pinned
certificates' expiry dates and pre-stage the successor pins before the
cutover, so a chain change never catches a single-chain client.

## Environment assumption

The monitor speaks TLS directly to the public host from `APP_URL` /
`NEXT_PUBLIC_APP_URL`, which is correct regardless of the reverse-proxy
topology — it observes the same leaf a real client does. The one assumption
is that the host the client connects to is the host in that env var. If the
client is pinned against a different hostname (e.g. a vanity domain that
fronts the configured `APP_URL`), point the monitor at that host by setting
`APP_URL` to it, or extend the job to probe the additional host. Plain-HTTP
self-hosts have no leaf to pin and the monitor no-ops there by design.
