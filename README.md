# Crypto Alt Bullet Trading Bot

Source code of the trading journal and PAPER/BingX VST executor.

## Workspace
- `artifacts/api-server`: API and trading execution workers
- `artifacts/trading-journal`: React trading journal
- `lib`: API contracts, generated clients and shared database code
- `docs`: execution and source-command documentation

## Development
Use Node.js 24 and pnpm. Install with `pnpm install`. See `replit.md` and package scripts for project-specific setup.
Credentials must be configured separately in Replit Secrets or a local environment; they are not stored here.

## Trading safety
PAPER and VST are separate from REAL/mainnet trading. This repository does not authorize or enable real-money trading.
Synchronizing source code does not publish the Replit application or close positions.

## GitHub synchronization
The **GitHub Source Sync** workspace workflow exchanges source changes with `main` every 30 seconds while the workspace is running.
It uses a separate source-only Git history, never Replit's internal checkpoint history.
Conflicting edits pause synchronization without overwriting either version.
See [the synchronization guide](docs/github-sync.md) for status, recovery and limitations.

Internal agent memory, conversations, operational handoffs, uploaded screenshots, caches and runtime secrets are excluded.
