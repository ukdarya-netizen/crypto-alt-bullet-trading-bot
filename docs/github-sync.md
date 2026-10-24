# GitHub ↔ Replit source synchronization

Repository: https://github.com/ukdarya-netizen/crypto-alt-bullet-trading-bot

The **GitHub Source Sync** console workflow runs `node scripts/github-sync.mjs --watch`.
It checks `main` every 30 seconds and waits for files to remain unchanged for
10 seconds before exchanging changes. It runs only while the Replit workspace
and this workflow are running, not as part of the published trading application.

## Safety boundaries

- A separate mirror under `.local/github-sync` preserves GitHub's clean source
  history. The workspace's checkpoint history is never pushed or rewritten.
  Mirror metadata is stored separately from the disposable checkout; every Git
  command explicitly selects it and cannot fall back to the parent repository.
  If metadata disappears, the next cycle rebuilds it from GitHub while retaining
  the three-way baseline, pending edits and conflict checks. A wrong remote,
  redirected metadata or partially corrupted metadata stops the exchange.
- Local and remote changes to different files can be exchanged in one cycle.
  Different changes to the same file, including edit/delete conflicts, pause
  the whole exchange. No side wins automatically.
- Pushes are fast-forward only. Concurrent remote commits cause a retry.
- Credentials, internal memory, uploads, handoffs, caches and build outputs are
  excluded. Symlinks, binary/oversized files and recognized credential patterns
  cause a visible error, never silent upload. This is not an exhaustive secret scanner.
- No automatic deployment, database migration, dependency installation or trading
  order is performed. Changed source files may still hot-reload in development.
  Review and test Claude's code before publishing.
- GitHub branch protection and authorization still apply. The repository's
  visibility is not changed by synchronization.

## Status and conflicts

Open the **GitHub Source Sync** workflow console, or run:

```sh
node scripts/github-sync.mjs --status
```

The persistent status is `.local/github-sync/status.json`, outside GitHub.
On conflict, it lists the affected files and makes no further changes. Review
both versions and make the workspace file identical to the desired GitHub
version (or update GitHub to the reviewed workspace version); the next cycle
then resumes. Do not delete the baseline to bypass a conflict.

Stop the workflow before a large multi-file refactor. A runtime-only pause
marker is also supported: `.local/github-sync/PAUSE`. Remove it to resume.
Changes from GitHub are written to the workspace but not auto-committed into
Replit's internal Git history, so they remain visible for review.

The original reviewed export is the initial three-way baseline. Initialization
is explicit and refuses to replace an existing baseline. A missing baseline or
changed repository identity stops synchronization instead of guessing.

## Tests

```sh
node --test scripts/github-sync.test.mjs
```

Tests use local disposable Git repositories; they do not touch GitHub, the
trading database or exchange accounts.

## Working with Claude

Ask Claude to commit and push its changes to `main` in this repository.
Uncommitted changes inside Claude's own environment cannot be synchronized.
Changes on another branch need to be merged into `main` first.
