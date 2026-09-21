# Upgrading to AGR 2.0

AGR 2.0 uses guide format version 2. The sidebar and JSON now share the same hierarchy: numbered sections, numbered changes, and independently checkable files. The progress bar counts reviewed file entries.

## Upgrade

1. Update the AGR extension and reload VS Code.
2. Run **AGR: Update Agent Skills**, or accept the skill-update prompt, for each global or repository installation you use. Start a fresh agent session afterward.
3. Open your existing review. AGR reads version 1 guides and upgrades them in place when their snapshot changes can be resolved. Save unsaved guide edits first.

The migration preserves notes, selected ranges, and valid per-file approvals. It never turns a stale approval into a valid one. Missing changes cannot be assigned a trustworthy file path, so an unresolved guide may remain in the old format until your agent regenerates it. Missing pinned commits must be fetched before migration can run.

## Format change

Version 1 stored file steps in `groups[].steps[]`. Version 2 stores them in `groups[].changes[].files[]`. Each change has its own stable ID and title. Each file entry includes its repository-relative `file`, snapshot change IDs, notes, optional selected ranges, and review state. IDs must be unique across sections, changes, and file entries.

The bundled skill generates version 2 directly. Its schema and validator are updated together with the extension. Existing multi-file steps are split into independently reviewable file entries during migration. Repeated change titles in legacy plans are used to recover groups only during migration; version 2 grouping follows the explicit structure.

## Compatibility

Version 2 guides require AGR 2.0 and its updated skill helper. Older extensions and helpers cannot read them. Keep a copy of version 1 guides before opening them in AGR 2.0 if you need to downgrade; there is no automatic downgrade conversion.

GitHub PR connections and review scopes are unchanged. GitHub Viewed sync still requires every covered part of a file to be reviewed against the current PR revision.
