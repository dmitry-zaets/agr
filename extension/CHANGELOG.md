# Changelog

Published release history is available in [GitHub Releases](https://github.com/dmitry-zaets/agr/releases). semantic-release adds the current release notes to this file during packaging. The entries below describe local prototype history.

## Upgrading to 1.1

Reviews now live in `.agr/<name>.json`, with a **Switch Review** picker and independent progress. Root `agr.json` is no longer read. Move existing guides into `.agr/` and update the installed Claude Code/Codex skills. Store snapshots and scope recipes under `.agr/.cache/`. The JSON guide structure is unchanged.

## 0.3.0

Initial AGR release, following local Review Guide prototypes.

- Ordered review sections with native diffs, short comments, and range markers.
- Independent steps for different parts of a file or diff hunk.
- Persistent reviewed status with change detection and uncovered-change tracking.
- PR, branch, commit range, staged, unstaged, combined, and mixed review scopes.
- Portable Claude Code and Codex skills with a bundled snapshot and validation helper.
- JSON schema completion and validation for `agr.json`.
- AGR branding, sidebar icon, and publishing documentation.

### Migration from local Review Guide builds

Install AGR and uninstall `dmitry-zaets.review-guide` to avoid duplicate sidebars. Rename `.review-guide.json` to `agr.json`, preserving its contents. Rename any `.review-guide.snapshot.json` and `.review-guide.scope.json` artifacts to `agr.snapshot.json` and `agr.scope.json`. Install the new `agr` skills and remove the old `review-guide` skill folders after preserving any customizations. Reload VS Code and start a fresh agent session.
