# Offline geolocation (GeoLite2)

The admin login overview shows a coarse `City, CC` location and a carrier
next to every sign-in. Two tiers can produce that:

- **Online.** A third-party lookup, `https://ipwho.is` by default. Free,
  keyless, and on by default — which also means every login IP address of
  every account on the instance leaves the host.
- **Offline.** MaxMind's GeoLite2-City and GeoLite2-ASN databases read
  from a local directory. The ASN database is the authoritative source
  for the carrier and the AS number. Note that the resolver is
  online-first: having the databases in place is not by itself enough to
  stop the outbound lookup, see "Turning the online lookup off entirely"
  below.

The offline tier is optional and absent by default. The published image
only carries the databases when the image build had a MaxMind licence key
(`scripts/fetch-geolite2.sh`, run from the release workflow), which is a
build-time decision you do not control when you pull `:latest`. Bringing
your own copy is the way to get the offline tier on a self-host, and it
is the subject of this page.

## What you need

- A free MaxMind account. Sign up at
  <https://www.maxmind.com/en/geolite2/signup>, then create a licence key
  under **My Account → Manage License Keys**. GeoLite2 is free; the
  account and key exist because MaxMind requires them for the download.
- `geoipupdate` (MaxMind's own downloader) or any other way to fetch the
  two `.mmdb` files onto the host. Most distributions package
  `geoipupdate`; there is also an official container image.

## Setup

1. Pick a directory on the host and fetch both databases into it. With
   `geoipupdate`, `/etc/GeoIP.conf` looks like this:

   ```conf
   AccountID <your-account-id>
   LicenseKey <your-licence-key>
   EditionIDs GeoLite2-City GeoLite2-ASN
   DatabaseDirectory /srv/healthlog/geolite2
   ```

   Then run `geoipupdate`. The directory should end up holding
   `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`. The City database is the
   one the readiness check looks for; the ASN database is what fills the
   carrier and AS number.

2. Mount the directory into the app container read-only. In
   `docker-compose.yml` the `app` service carries a commented `volumes:`
   block for exactly this:

   ```yaml
   volumes:
     - /srv/healthlog/geolite2:/var/lib/geolite2:ro
   ```

3. Point the runtime at the container path:

   ```env
   GEOLITE2_DIR="/var/lib/geolite2"
   ```

   `GEOLITE2_DIR` is on the compose `environment:` whitelist, so a value
   in your `.env` reaches the container. Variables that are not on that
   whitelist never do, even when compose substitutes them elsewhere in
   the file.

4. `docker compose up -d` and sign in once. **Admin → System status**
   shows `Geo data: Offline (GeoLite2)` when the databases are being
   read, and names the online provider when they are not.

## Turning the online lookup off entirely

Once the offline tier resolves, the third-party lookup is redundant. To
stop all IP egress:

```env
IP_GEO_LOOKUP_DISABLED="1"
```

The resolver then uses only the local databases and returns nothing when
they miss, rather than asking anyone. An instance handling other people's
health data is a reasonable place to make that trade.

## Keeping the databases current

MaxMind reissues GeoLite2 on its own schedule, and a stale city database
is quietly wrong rather than loudly broken — it keeps answering, with
last month's allocations. Run `geoipupdate` on a schedule (a weekly cron
or systemd timer is enough) against the same directory.

The reader loads each database once per worker process and holds it, so a
refreshed file on the host is picked up at the next container restart,
not immediately. A weekly `geoipupdate` followed by
`docker compose restart app` keeps the two in step.

## Licence and attribution

The databases are downloaded under your own MaxMind account, so their
terms are between you and MaxMind — read what your account agrees to at
<https://www.maxmind.com/en/geolite2/eula>. HealthLog's own attribution
("this product includes GeoLite2 data created by MaxMind") is already on
the `/about` page and covers an instance that uses them.

## Troubleshooting

**System status still says the online provider.** The readiness check
requires `GeoLite2-City.mmdb` to exist in `GEOLITE2_DIR` and no `.empty`
marker file beside it. Check the path from inside the container:
`docker compose exec app ls -l /var/lib/geolite2`. An empty listing means
the bind mount did not land; a `.empty` file means the image was built
without a licence key and you are still reading the baked-in directory
rather than your own.

**The variable has no effect.** Confirm it actually reached the process:
`docker compose exec app printenv GEOLITE2_DIR`. If it prints nothing,
the value is in `.env` but not on the `environment:` whitelist — compare
against `docker-compose.yml`.

**The carrier column is empty.** The carrier also comes from the online
provider's ISP field, so it is normally filled even without the ASN
database. If both tiers are off (`IP_GEO_LOOKUP_DISABLED="1"` and no
`GeoLite2-ASN.mmdb`), there is no source for it and it stays empty.
