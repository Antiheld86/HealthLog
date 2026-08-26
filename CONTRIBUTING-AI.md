# Contributing with AI tooling

HealthLog is built with AI assistance, and contributions made the same way are welcome. This file used to carry a copy of the internal conventions document; the copy aged badly and started contradicting the codebase, so it now points at the living sources instead.

## Where the real conventions live

- `CLAUDE.md` at the repo root is the maintainer's operating manual for this codebase: architecture walk, code conventions, security patterns, test commands, the do-not list. It is checked in and kept current; whatever an AI agent (or a human) needs to work on the server is in there.
- `docs/CONTRIBUTING-CLIENTS.md` covers building a client app (Android, iOS, CLI) against the server: the API contract, auth from a client's point of view, sync semantics, and how coordination between repos works.
- `docs/api/openapi.yaml` is the wire contract, generated from the server's Zod schemas. CI fails on drift, so it is always accurate for the commit it sits in.

## Ground rules, whatever tooling you use

- The human who commits a change has read it and stands behind it. The git history knows authors, not tools: no AI attribution trailers, no assistant vocabulary in commit messages, PR text, or release notes.
- No real names of users or reporters in committed text, and no live health figures anywhere, including fixtures and examples. Invent data.
- No secrets in code, fixtures, or docs, and nothing secret-shaped either.
- Run the gates before pushing (`pnpm typecheck`, `pnpm lint`, `pnpm test`) and fix what they find rather than suppressing it. A guard that fails is telling you something; the fix goes in the code, not in the guard.
