# Crypto Alt Bullet Trading Bot

Private source snapshot of the trading journal and PAPER/BingX VST executor.

## Workspace
- artifacts/api-server: API and trading execution workers
- artifacts/trading-journal: React trading journal
- lib: API contracts, generated clients and shared database code
- docs: execution and source-command documentation

## Development
Use Node.js 24 and pnpm. Install with pnpm install. See replit.md and package scripts for project-specific setup.
Credentials must be configured separately in Replit Secrets or a local environment; they are not stored here.

## Trading safety
PAPER and VST are separate from REAL/mainnet trading. This export does not authorize or enable real-money trading.
Publishing code to GitHub does not deploy the Replit application or close positions.

## Export scope
This is a fresh source snapshot, not Replit's internal checkpoint history.
Internal agent memory, conversations, operational handoff data, uploaded screenshots, caches and runtime secrets are excluded.
GitHub uploads are not an automatic background sync with Replit.
