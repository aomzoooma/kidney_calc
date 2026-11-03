# Encrypted export prototype

`nutrition.backup.create_backup()` writes an authenticated, encrypted logical
SQLite export for the application's marked synthetic-only database. Snapshot
uses SQLite's backup API, including committed WAL contents, then exports SQL
statements from the in-memory snapshot. AES-256-GCM authenticates the fixed
format header and payload; a random 16-byte salt feeds scrypt (`N=2^15, r=8,
p=1`) to derive the key. The passphrase is never written to the file.

This is export-only. There is no decryption, restore, migration, UI, or claim
that restoration works. Do not use real patient data. The marker is a database
assertion, not proof that its contents are synthetic. Export rejects unknown
tables, changed columns, generated columns, and text values containing NUL;
checks SQLite integrity and foreign keys; and caps the source database at
16 MiB and logical export at 64 MiB. Schema checks do not fingerprint every
constraint or trigger definition.

The format is a logical SQL dump, not a byte-for-byte SQLite image. It does not
preserve database-level PRAGMAs such as `user_version` or `application_id`.
Round-trip tests cover BLOB, NULL, Unicode, indexes, views, triggers, and
`sqlite_sequence`, but this does not make the prototype restore-capable.
Restoration remains blocked on reviewed protected staging, atomic no-clobber
publication, crash cleanup, and actual Windows ACL validation. Windows has
not been tested; encrypted output may fail where same-volume hard links are
unsupported. Keep the selected output directory private.
