# AGENTS.md

Entry point for coding agents working on this repository, whatever harness they run in.

## Read CLAUDE.md first. It is the operating manual.

`CLAUDE.md` carries the architecture walk, the code conventions, the security patterns, the
branch and release model, the self-hosting gotchas and the DO-NOTs. It is maintained. This file
is not a summary of it and must never become one.

That is deliberate, and the reason is written in scar tissue. The previous version of this file
duplicated the project description, the version, the stack table, the command list and a tree of
the source layout. It then sat untouched for roughly thirty releases. It announced "v1.4.0
released, v1.4.1 in progress" long after the version had passed 1.33, and described the UI as
Dracula-themed long after the palette had been replaced by tokens with a light theme beside it.
Anything that duplicates a moving fact will eventually assert a false one, and a confidently
wrong instruction file is worse than none. So this one points rather than copies.

## What is genuinely specific to working here as an agent

- **Never read anything under `src/generated/`.** It is the generated Prisma client, roughly
  9 MB across 83 files including a 224 KB inline schema. Reading or grepping it exhausts a
  context window and stalls the session. Regenerate it with `pnpm prisma generate`; never open
  it. Treat `pnpm-lock.yaml`, `CHANGELOG.md`, `messages/*.json` and `docs/api/openapi.yaml` the
  same way: grep them narrowly, do not read them whole.
- **The gate before anything is called finished:**
  `pnpm typecheck && pnpm lint && pnpm format:check && TZ=UTC pnpm test && pnpm build`.
  `TZ=UTC` is load-bearing, because CI runs in UTC and a timezone-fragile date test passes
  locally and fails there. `pnpm test:integration` needs Docker. `pnpm e2e` is heavy and worth
  running locally before pushing a large branch; skipping it has cost five CI rounds before.
- **Read the output, not the exit code.** `tsc` colours its output, so counting matches for an
  error string can return zero while errors are open. A shell chain of two commands can report
  success for the second while the first failed.
- **Working notes live in `.planning/`**, which is gitignored. Build plans, audits, design
  documents and reconcile notes are there. Read them before planning anything, because they
  usually already contain the measurement about to be redone.
- **Parallel work happens in git worktrees off `origin/main`**, one stream per worktree,
  file-disjoint. Commit early: a worktree can break and uncommitted work is lost work. Each
  worktree carries its own Prisma client, so regenerate in the main tree after merging.

## Hard rules for every committed artefact

Stated in full in `CLAUDE.md` under "Voice and privacy". Repeated here because they are the ones
most often broken by an agent that skipped the manual.

- No tooling or assistant vocabulary in anything that reaches GitHub: not in commit messages,
  branch names, PR bodies, code comments or release notes. No `Co-Authored-By` trailer.
- No personal names, no live health figures, no account identifiers.
- English, in the maintainer's voice: present-tense imperative for commits, factual for prose.
- Never `--no-verify`. Never force-push `main` or a release branch. Never `--no-gpg-sign` unless
  asked.

## When a claim and the code disagree

Fix the claim. A comment, a docblock or a release note asserting behaviour the code does not
have is treated as a defect here, not as documentation drift. More than one real failure in this
project began as prose that nothing enforced, including one that shipped a fix which did
nothing while its notes said otherwise. If it cannot be fixed inside the change being made, say
so plainly in the same file rather than leaving the false sentence standing.
