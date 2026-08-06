# Sharing a health record with another account

Two accounts on the same instance can be connected so that one of them
can open the other's health record. A parent and an adult child, two
partners, somebody keeping an eye on a relative's blood pressure — the
case this exists for is a household, not an organisation.

This page describes what that connection does, what it deliberately does
not do, and which of the instance's existing trust properties it leaves
exactly as they were.

## The shape of it

One account **shares**; the other is **given access**. In the code and in
the settings copy these are the owner and the person they invited.

- The owner opens **Settings → Shared access** and invites somebody by
  the username or e-mail address that person signs in with. They need an
  account on this instance already; there is no invite-by-e-mail flow.
- **The invitation confers nothing.** Until the other person accepts it,
  it is an offer sitting in their own settings. Being handed read access
  to somebody's health record is not something the product imposes
  silently, and the acceptance — with its timestamp and the accepting IP —
  is what the row records.
- Once accepted, the record shows up in that person's user menu under
  "Open a record". Opening it reloads the app into the owner's record.
- A banner across the top of every page names whose record is open and
  says it is read-only, with a button back to the person's own. It is
  loud on purpose: somebody who forgets they are switched will log their
  own reading into another person's record, and there is no undo for an
  entry that was never theirs.
- Either side can end it at any time. The owner withdraws access; the
  other person hands it back. Both are one click with no second factor
  and no typed confirmation — reducing access must never be harder than
  granting it was.

## What the other person can and cannot do

**Read the health record.** Measurements, medications, mood, labs, the
illness journal, preventive-care reminders, documents. In this release
that is the whole of it: every grant is read-only. The write level exists
in the data model so that adding it later is enforcement work rather than
a migration, and no invitation can create one today.

**Nothing about the account around the record.** This is the line the
whole feature is built on, and it is drawn on the server:

| Not reachable                                                                                | Why it would matter                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Password, passkeys, second factor, recovery codes                                            | Silent takeover, surviving any revocation                                |
| Sessions, trusted devices, sign-out-everywhere                                               | Ending or enumerating the owner's logins                                 |
| API tokens, the MCP connector                                                                | A durable credential that outlives the access                            |
| Connected services (Withings, Fitbit, WHOOP, Google Health, Polar, Oura, Strava, Nightscout) | Re-pointing a sync, or feeding somebody else's wearable into this record |
| Notification channels and push devices                                                       | The owner's health alerts redirected to another phone or chat            |
| Exports, the health-record archive, clinician share links                                    | A one-click copy of everything, or a new door that outlives the access   |
| Insights and the Coach                                                                       | AI processing of the owner's data, under the owner's own consent         |
| Sharing itself                                                                               | Inviting somebody else, widening the access, or passing it on            |
| Locale, theme, dashboard layout                                                              | Presentation belongs to the person, not to the record                    |

The last two rows are worth a sentence each. Sharing is not
transferable: somebody given access cannot invite a third person, cannot
raise their own level, and cannot hand it on. And display preferences
stay with the person at the keyboard, so reading somebody else's record
does not change your own theme, language or dashboard.

The AI row is the one that looks arbitrary and is not. Server-managed AI
features send the record's data to a provider under a consent the record's
OWNER gave, for their own use. Somebody else triggering that would create
a consent-shaped act the owner never made, so those surfaces stay
owner-only.

These are not checks that a page forgot to render. Every route in the
product refuses by default while a browser is acting on another account;
a route becomes reachable only by declaring it, and the set of declared
routes is frozen by a test.

## Revocation, and what it cannot undo

Ending access takes effect on the other person's **next request**, not at
their next login. The grant is checked against the database on every
single request, so there is no cached verdict to wait out. If their
browser is sitting inside the record when the owner ends it, the same
database transaction puts that browser back into its own account — they
land at home rather than on a wall of refusals.

What revocation cannot do is take back what was already seen. A person
who had read access could have read, remembered, screenshotted or written
down anything in the record. The product can close the door; it cannot
reach through it. Nothing in the interface implies otherwise, and neither
does this page.

Ending access never deletes the record of it. The row stays with the
dates and with who ended it, because "who had access, from when to when,
and who ended it" is a question a deleted row cannot answer. Re-inviting
the same person creates a new row beside the old one.

## Seeing what happened

**Settings → Shared access** answers three questions for the owner, at
any time: who can open this record, since when, and when they last did.
Below that, a list of the days somebody else opened it and how many times
— one line per person per day, rather than a line per request.

That list is bounded by the instance's audit retention, and the page says
so with the actual number rather than a hardcoded one. The default is 365
days (`AUDIT_LOG_RETENTION_DAYS`); an operator who shortens it shortens
this view too, and the sentence under the heading changes to match. The
query is bounded to that window, so the sentence is the real limit of the
list rather than a caption over an unbounded one.

Two things the list does not claim, both worth reading before treating it
as an answer:

- **An empty list is not proof that nobody opened the record.** It means
  nobody did so within the window, and that any earlier row has been
  purged.
- **The list is capped.** It returns at most the hundred most recent rows
  inside the window; when it hits that ceiling it says so under the
  heading. A busy household can reach the cap in far less time than the
  retention window, and the oldest line on screen is then the oldest line
  shown, not the oldest that exists.

## What this does not change about the instance

Stated plainly, because a sharing feature is exactly the moment somebody
re-reads the trust model:

- **The operator could always read the database.** Anyone with server or
  database access, and anyone with an admin account on this instance, can
  reach health data directly. That was true before sharing existed and is
  unchanged by it. On a household instance the operator is usually one of
  the people using it; on an instance hosting other people, it is worth
  saying out loud.
- **Encryption at rest is instance-keyed, not per-user.** The encrypted
  columns are protected by the key in `ENCRYPTION_KEYS`, which belongs to
  the instance. Sharing does not weaken that, and it never did protect one
  account's data from the operator of the same instance.
- **AI processing stays under the record owner's consent**, because the AI
  surfaces are not part of what sharing covers.

## For operators

Nothing to configure. Sharing is available on every instance, needs no
environment variable, and does nothing until one account invites another.

Two operational notes:

- **Invitations disclose whether a username exists.** An invitation to a
  name nobody uses is refused with "no account with that name". That is
  deliberate: the alternative is a silent pending row that will never be
  accepted because the owner mistyped. The caller is already
  authenticated and the endpoint allows ten invitations an hour per
  account, which bounds how fast the surface could be walked.
- **Deleting an account** removes the grants it is party to. The audit
  rows naming that account as the one who opened somebody's record stay,
  and render as "a deleted account" — nulling them would turn "your
  daughter opened your record" into "you opened your record", which is
  worse than an unresolvable id.
