# Security recovery and credential revocation

A password reset is an account-recovery event, not just a password-hash
change. The operator reset CLI revokes every access path for the target
account so a stolen session, native refresh token, long-lived API token,
trusted device, or temporary step-up proof cannot survive the new password.

Use the operator procedure in [Password reset](password-reset.md) and prefer
its hidden stdin prompt:

```sh
docker compose exec app node scripts/reset-password.mjs <username-or-email>
```

Do not put the new password in shell history, a ticket, chat, or logs.

## What a successful operator reset revokes

The CLI performs one serialized database transaction for exactly one matched
user. It:

1. locks the target account and writes the new password hash;
2. deletes every web session;
3. revokes every API access token;
4. revokes every native refresh token;
5. deletes every trusted device; and
6. deletes every live step-up elevation.

The safe completion message reports only the username and affected row counts.
It never prints the password, password hash, tokens, cookies, or health data.
Unrelated users are not changed.

The in-app administrative reset follows the same target-user revocation
policy for sessions, API tokens, native refresh tokens, and trusted device
records. Operators should still use the CLI recovery path when rollback-safe
direct recovery is required.

## Rollback guarantee

The operator CLI wraps identity resolution, password rotation, and every
revocation above in `BEGIN`/`COMMIT`. Any error issues `ROLLBACK` before the
database connection closes. A failed reset therefore does not leave a new
password paired with old credentials, or old password state paired with only
some credentials revoked.

Treat any non-zero exit as “nothing committed.” Correct the operational
problem and run the whole command again; do not manually complete a subset of
the SQL statements.

## After recovery

- Have the user sign in with the new password and enroll replacement trusted
  devices intentionally.
- Expect every browser and native client to require a fresh login.
- Reissue only the minimum API or MCP scopes each integration needs.
- Review security activity without copying credential material into the
  incident record.
- If compromise is suspected beyond one account, rotate the affected
  instance-level secrets using the relevant operator runbooks before
  restoring integrations.
