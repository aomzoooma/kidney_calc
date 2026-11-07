# Encrypted export prototype

`nutrition.backup.create_backup()` writes an authenticated, encrypted logical
SQLite export for the application's marked synthetic-only database. Snapshot
uses SQLite's backup API, including committed WAL contents, then exports SQL
statements from the in-memory snapshot. AES-256-GCM authenticates the fixed
format header and payload; a random 16-byte salt feeds scrypt (`N=2^15, r=8,
p=1`) to derive the key. The passphrase is never written to the file.

Restore is intentionally disabled. Independent review found two blockers:

- SQLite `TEXT` affinity accepts invalid domain values. A valid authenticated
  dump can store `"bogus"` in `dry_weights.kilograms`; structural, integrity,
  and foreign-key checks do not catch it. Full per-column and cross-record
  validation is required before publication.
- Export permits custom indexes, views, and triggers. A restore that drops
  them silently loses data/schema; replaying them would run untrusted SQL.
  Restore must verify exact application-owned object definitions and fail
  closed on unsupported objects.
- A failed directory `fsync` after publishing a hard link could report an
  error while leaving the destination present. Publication/durability errors
  need an explicit result contract and adversarial test.

The marker remains an assertion, not proof that data is synthetic. Do not use
real patient data. Windows remains unsupported until target ACL and atomic
publication behavior are verified. Any eventual restore also needs protected
staging, no-clobber publication, crash cleanup, and clear OS memory/disk
limitations; plaintext may reach swap, crash dumps, journals, or snapshots.

The format is a logical SQL dump, not a byte-for-byte SQLite image. It does not
preserve database-level PRAGMAs such as `user_version` or `application_id`.
Export round-trip tests cover BLOB, NULL, Unicode, indexes, views, triggers,
and `sqlite_sequence`. Restore, photo backup, migrations, UI, Windows/phone
verification, and production readiness remain out of scope.
