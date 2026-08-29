# HealthLog over Tailscale

For a single Docker box that only you and your household need to reach,
`tailscale serve` can stand in for the reverse proxy entirely. Tailscale
terminates HTTPS with a certificate every device on your tailnet already
trusts, there is no extra container to run and nothing to renew, and the
free plan covers all of it. The trade is scope: the instance is reachable
only from devices signed into your tailnet, which for a personal health
record is usually the point.

Two modes exist, and the difference matters more here than for most apps:

- **`tailscale serve`** publishes HealthLog inside your tailnet only.
  Every device that should reach it runs the Tailscale client and signs
  into the same tailnet, including the iPhone if you use the iOS app.
  The instance is invisible from the public internet. This is the right
  default for a personal health record.
- **`tailscale funnel`** publishes the same HTTPS endpoint to the public
  internet. No client is needed on the phone, but anyone on the internet
  can reach the sign-in page, so the instance becomes a public deployment
  and needs to be treated like one. Funnel is the deliberate opt-in, not
  the default.

## Set up `tailscale serve`

1. Install Tailscale on the Docker host and sign in. On macOS, the
   standalone app from tailscale.com is more full-featured than the App
   Store build; either works for this page.

2. With the compose stack running on `localhost:3000`, run:

   ```bash
   tailscale serve --bg localhost:3000
   ```

3. If HTTPS certificates are not yet enabled for your tailnet, the CLI
   says so and prints the admin-console link that enables them. Follow
   that link once; it is a one-time, per-tailnet step.

4. The CLI prints the HTTPS URL it now serves, of the form
   `https://<machine>.<tailnet>.ts.net`. `--bg` persists the
   configuration across restarts, so this is a run-once command, not
   something to add to a boot script.

## Point HealthLog at the tailnet URL

Set the URL pair in `.env` to the exact HTTPS URL the CLI printed:

```env
NEXT_PUBLIC_APP_URL="https://your-machine.your-tailnet.ts.net"
APP_URL="https://your-machine.your-tailnet.ts.net"
```

Both variables are on the bundled compose `environment:` whitelist, so
values in `.env` reach the container. Restart to pick them up:

```bash
docker compose up -d
```

## Cookies and TLS

`tailscale serve` terminates real HTTPS, so the session cookie's
`Secure` flag works exactly as it does behind any TLS-terminating proxy.
Leave `SESSION_COOKIE_SECURE` unset. The plain-HTTP escape hatch in the
[reverse-proxy guide](reverse-proxy.md) exists for serving the raw
`http://host:3000` surface across a trusted network without a TLS front;
once `serve` fronts the app you do not need it.

`serve` is a single proxy hop in front of the app, which is the topology
the default `TRUST_PROXY_HOPS=1` assumes. If the wide-event log shows a
null client IP after the switch, or every caller lands in one shared
rate-limit bucket, the "Verifying the proxy chain" section of the
reverse-proxy guide shows how to read the mismatch warning and adjust.

## The iOS app and Apple Health

With `serve`, the iPhone reaches the instance the same way every other
device does: install Tailscale from the App Store on the phone, sign
into the same tailnet, then point the HealthLog iOS app at the
`https://<machine>.<tailnet>.ts.net` URL. Apple Health sync works over
this path; from the app's perspective the tailnet URL is an ordinary
HTTPS origin with a trusted certificate.

## Public exposure with `tailscale funnel`

If the instance must be reachable without the Tailscale client, for
example for someone outside your household's tailnet, `tailscale funnel`
publishes the endpoint to the public internet. The command shape mirrors
`serve`; follow the CLI's own output, which walks through any
admin-console enablement funnel needs on your tailnet.

Before opening it, accept what it means: the sign-in page is now
internet-facing. Close public registration once every household member
has an account (the toggle lives in `/admin`, see
[`getting-started.md`](getting-started.md)), and keep the image current
via `pull_policy: always` as documented there. Everything the other
guides say about publicly reachable hosts applies unchanged.

## Costs

The free Tailscale plan is enough for everything on this page.
