#!/bin/bash
set -e
pnpm install --frozen-lockfile
push_output="$(mktemp)"
trap 'rm -f "$push_output"' EXIT
set +e
pnpm --filter @workspace/db --fail-if-no-match run push-force 2>&1 | tee "$push_output"
push_status=${PIPESTATUS[0]}
set -e
if [ "$push_status" -ne 0 ]; then
  echo "Database schema push failed with exit status $push_status; development schema verification was not run." >&2
  exit "$push_status"
fi
node scripts/check-schema-push-output.mjs "$push_output"
pnpm --filter @workspace/db --fail-if-no-match run verify-vst-fill-archive-schema
