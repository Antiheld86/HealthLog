# Password reset (operator)

A self-hosted operator can reset a single user's password from inside the
running container. This is an **operator-only** maintenance path — there is no
self-service reset route for users, and it bypasses the normal
account-recovery flow. Admins do have an in-app alternative:
`POST /api/admin/users/{id}/reset-password` (cookie-admin only) sets a new
password and destroys the user's sessions, tokens, and trusted devices. The
CLI remains the path when no admin can log in. Use it only for an account you
administer (for example, after a forgotten password on a single-user
instance).

> **Operator-only.** The script writes directly to the `users` table and is
> intended to be run by the host operator with database access. Treat the new
> password like any other secret: pass it on stdin (it is read without echoing)
> rather than as a shell argument where it would land in shell history and the
> process list.

## Run it

The reset CLI ships in the image from v1.39.3 on. It runs under plain `node`
against the built runtime: a `.mjs` file that uses the in-image `pg` and
`@node-rs/argon2` directly and reuses the app's exact Argon2id parameters.
Images up to and including v1.39.2 did not contain the script, so on those
the command below fails with "Cannot find module"; use the source-checkout
form at the end of this page instead.

```sh
docker compose exec app node scripts/reset-password.mjs <username-or-email>
```

The script prompts for the new password without echoing it, then prints a
confirmation that names only the user — never the password:

```
New password (input hidden):
reset-password: password updated for "alice"; revoked 2 sessions, 0 API tokens, 1 refresh tokens, 0 trusted devices, and 0 step-up elevations
```

You can also pass the password as a second argument for non-interactive use,
but prefer the stdin prompt so the secret stays out of shell history:

```sh
docker compose exec app node scripts/reset-password.mjs alice 'a-strong-passphrase'
```

## Behaviour

- The identifier is matched **case-insensitively** against `username` **or**
  `email`, mirroring the login lookup.
- The match must resolve to exactly one user. Zero matches exits non-zero with
  `no user matches "<id>"`; multiple matches exits non-zero and refuses to guess.
- The new password must be at least 12 characters (the app's minimum).
- The password is hashed with Argon2id using the same cost parameters as the
  application (`src/lib/auth/argon2-params.mjs`), so the stored hash is
  identical to one the app would mint.
- `DATABASE_URL` is read from the environment — the same variable the app uses,
  honouring any `sslmode=` in the connection string.

## Source checkout

From a source checkout of the same release (after `pnpm install`) the same
script runs under Node directly. It needs a `DATABASE_URL` that reaches the
database; the bundled `db` service publishes no port, so on a stock compose
stack run it inside the compose network or publish the port temporarily:

```sh
DATABASE_URL='postgres://…' node scripts/reset-password.mjs <username-or-email>
```
