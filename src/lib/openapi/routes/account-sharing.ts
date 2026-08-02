/**
 * OpenAPI route table — account sharing (v1.36.0).
 *
 * The lifecycle of one account's standing permission to read another's record:
 * the owner invites, the delegate accepts, either side ends it, and a browser
 * points itself at a record it has been granted.
 *
 * Two contract facts a client has to know and cannot derive:
 *
 *   * `POST /api/account/switch` is a browser-session feature. The Bearer
 *     transport carries its account selector in the `X-HealthLog-Account`
 *     header, per request, and gets a 400 from this endpoint — a token must
 *     never accumulate switch state, because the credential has to keep
 *     meaning "this person" for as long as it exists.
 *   * Every route here refuses while the caller is acting on another account
 *     (403, `meta.errorCode: "sharing.not_permitted"`), with the single
 *     exception of the switch endpoint, which is the way back out. A delegate
 *     cannot invite, widen, transfer, or end anybody's access from inside a
 *     record they were given.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  inviteGrantSchema,
  switchAccountSchema,
} from "@/lib/validations/account-sharing";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

inviteGrantSchema.meta({
  id: "AccountGrantInvite",
  description:
    "Offer read access to another account on this instance. `identifier` is the invitee's username or e-mail, matched case-insensitively — the same identifier they sign in with. `expiresAt` is optional; omitted or null means the grant runs until somebody ends it. The access level is not a parameter: v1 grants READ only.",
});

switchAccountSchema.meta({
  id: "AccountSwitchRequest",
  description:
    "Point this browser session at an account, or (with `accountId: null`) back at its own. Cookie transport only.",
});

const grantParty = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
  })
  .meta({
    id: "AccountGrantParty",
    description:
      "The account on the other end of a grant. E-mail addresses are deliberately not published: a grant is not a way to collect the other party's contact details.",
  });

const grantState = z.enum(["PENDING", "ACTIVE", "EXPIRED", "REVOKED"]).meta({
  id: "AccountGrantState",
  description:
    "What the grant is right now, resolved server-side against the request clock. Only ACTIVE confers anything. Ordering is stated rather than implied: a revoked grant reads REVOKED even if it also sat past its expiry, and an unaccepted invitation past its expiry reads EXPIRED rather than PENDING because it can no longer be accepted. Clients render this value and never re-derive it from the timestamps.",
});

const grantView = z
  .object({
    id: z.string(),
    account: grantParty,
    access: z.enum(["READ", "WRITE"]),
    state: grantState,
    invitedAt: z.string(),
    acceptedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    revokedBy: z.enum(["GRANTOR", "GRANTEE"]).nullable(),
  })
  .meta({
    id: "AccountGrant",
    description:
      "One grant, from either side. The row is also the consent record — who offered the access, when it was accepted, when and by whom it ended — so ended grants stay in the list with `state: REVOKED` rather than disappearing. `revokedBy` distinguishes the owner withdrawing access from the delegate handing it back. `lastUsedAt` mirrors API-token semantics: the last time the grant was actually exercised.",
  });

const endedGrantView = grantView
  .extend({
    sessionsCleared: z
      .number()
      .int()
      .describe(
        "How many of the delegate's browser sessions were sitting inside the record and were put back into their own account, in the same transaction that ended the grant.",
      ),
  })
  .meta({
    id: "EndedAccountGrant",
    description:
      "A grant that has just been ended, plus what the cleanup did. Nothing is deleted: the row survives as the consent record and DELETE names the act, not the storage.",
  });

const grantListResponse = z
  .object({
    given: z.array(grantView),
    received: z.array(grantView),
  })
  .meta({
    id: "AccountGrantList",
    description:
      "Both directions at once: `given` are the grants this account has offered on its own record, `received` are the ones offered to it. Capped at 100 rows per direction, newest first.",
  });

const switchResponse = z
  .object({
    actingAs: z
      .object({
        accountId: z.string(),
        username: z.string(),
        displayName: z.string().nullable(),
        access: z.enum(["READ", "WRITE"]),
      })
      .nullable(),
  })
  .meta({
    id: "AccountSwitchState",
    description:
      "The account this session is now acting on, or null when it is back in its own. The stamp is a selector and not a permission — the grant is re-checked on every subsequent request, so a revocation lands on the next one rather than at the next login.",
  });

const sharingRefusal = {
  description:
    "Refused. `meta.errorCode` is `sharing.not_permitted` when the request was made while acting on another account (grant management is never delegable), or `sharing.access.denied` when the caller may not act as the account they named. The latter is byte-identical for an account that does not exist and one that granted nothing — the refusal is not an enumeration oracle.",
  content: { "application/json": { schema: errorEnvelope } },
};

export const accountSharingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/account/grants": {
    get: {
      tags: ["Account sharing"],
      summary: "List grants in both directions",
      description:
        "Every grant this account has given or received, ended ones included. Refused while acting on another account.",
      responses: {
        ...stdResponses,
        "200": {
          description: "Grants given and received.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                grantListResponse,
                "AccountGrantListEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
      },
    },
    post: {
      tags: ["Account sharing"],
      summary: "Invite an account to read this record",
      description:
        "Offers read access to somebody already registered on this instance; the grant confers nothing until they accept it. An identifier that names no account answers 404 — a deliberate disclosure to an authenticated caller on a household instance, rate-limited to 10 invitations an hour, and the alternative (a silent pending row for a mistyped username) is worse. Refused while acting on another account, so a delegate can neither invite nor re-delegate.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: inviteGrantSchema } },
      },
      responses: {
        ...stdResponses,
        "201": {
          description: "The pending grant.",
          content: {
            "application/json": {
              schema: dataEnvelope(grantView, "AccountGrantEnvelope"),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No account on this instance carries that identifier.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "That account already holds a live grant on this record (`meta.errorCode: sharing.invite.duplicate`). Re-inviting somebody whose access was revoked succeeds and mints a new row; the old one stays as history.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "Validation failed, or the invitation named the caller's own account (`meta.errorCode: sharing.invite.self`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "Invitation rate limit exceeded.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}/accept": {
    post: {
      tags: ["Account sharing"],
      summary: "Accept an invitation",
      description:
        "The delegate's own act, and the consent record: it stamps the acceptance time and the accepting IP on the grant row. One-shot and delegate-only — the invited account comes from the session, so an invitation addressed to somebody else answers 404 rather than confirming it exists.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The now-active grant.",
          content: {
            "application/json": {
              schema: dataEnvelope(grantView, "AcceptedAccountGrantEnvelope"),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such invitation for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Already accepted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "410": {
          description: "The invitation lapsed or was withdrawn.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}": {
    delete: {
      tags: ["Account sharing"],
      summary: "Withdraw access (owner)",
      description:
        "Ends a grant on the caller's own record. No step-up and no confirmation step — reducing access must never be harder than granting it. Enforcement is the delegate's next request, not their next login, and the same transaction puts every browser session of theirs that was inside the record back into their own account. Nothing is deleted: the row survives with `revokedAt` and `revokedBy: GRANTOR`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The ended grant, and what the session cleanup did.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                endedGrantView,
                "RevokedAccountGrantEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such grant on this account's record.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "That access had already ended.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}/renounce": {
    post: {
      tags: ["Account sharing"],
      summary: "Hand access back (delegate)",
      description:
        "The same transition as the owner's revoke, attributed the other way (`revokedBy: GRANTEE`) so the record can tell a withdrawal from a handover. Same session cleanup. Refused while acting on the record being renounced — switch back first (one request), which keeps grant management non-delegable without exceptions.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The ended grant, and what the session cleanup did.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                endedGrantView,
                "RenouncedAccountGrantEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such grant held by this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "That access had already ended.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/switch": {
    post: {
      tags: ["Account sharing"],
      summary: "Act on a granted record, or return to your own",
      description:
        "Cookie transport only; a Bearer caller gets 400 (`meta.errorCode: sharing.switch.wrong_transport`) and should send the `X-HealthLog-Account` header on the requests it wants scoped instead. The grant is validated here so the client gets an honest refusal immediately, but the stamp authorises nothing on its own — every following request re-checks the grant. `accountId: null` clears the switch and always works, including from inside a switched session: this endpoint is the way out.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: switchAccountSchema } },
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The account this session is now acting on, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(switchResponse, "AccountSwitchEnvelope"),
            },
          },
        },
        "400": {
          description:
            "Sent over the Bearer transport, which carries its selector per request instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": sharingRefusal,
        "422": {
          description: "Validation failed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
