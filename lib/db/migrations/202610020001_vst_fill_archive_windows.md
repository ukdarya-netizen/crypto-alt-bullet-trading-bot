# VST fill archive migration

These are additive migrations: they create the VST window archive, normalized
immutable fill-identity table, idempotency index, and nullable window
invalidation metadata. They do not remove existing tables or archive evidence
and are not applied by application startup.

For development databases only, apply explicitly:

```sh
psql "$DEVELOPMENT_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/202610020001_vst_fill_archive_windows.sql \
  -f lib/db/migrations/202610020002_vst_fill_archive_immutable_fills.sql \
  -f lib/db/migrations/202610020003_vst_fill_archive_invalidation.sql
```

Managed production schemas must be updated through **Publish only**. Do not
apply these SQL files manually to production.