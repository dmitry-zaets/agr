# Contributing to AGR

Use Node.js 22.14+ in the 22.x line or 24.10+, npm, Git, and VS Code 1.95+. Clone the repository and run:

```sh
npm ci
npm run check
npm run test:extension
npm run package
```

`npm run check` type-checks, runs disposable Git fixture tests, and rebuilds the extension and portable skill. Integration tests launch a separate VS Code profile and temporary repository. On Linux, run them under `xvfb-run -a` if there is no display. The runner uses installed VS Code on macOS when available and otherwise downloads a test build.

For interactive development, build first, open `extension/` in VS Code, and press F5. Rebuild and reload the Extension Development Host after source changes.

## Where changes belong

- `extension/src/`: sidebar, commands, diff navigation, comments, and persistence.
- `packages/core/src/`: Git snapshots, scope resolution, guide format, and CLI.
- `packages/core/guide.schema.json`: authoritative JSON schema.
- `skills/agr/`: agent instructions and scope recipes.

The checked-in `skills/agr/scripts/agr.cjs` and `skills/agr/guide.schema.json` are generated so the skill works when copied on its own. Edit their source and run `npm run build`; include generated changes with the source changes. Do not hand-edit generated bundles. Extension bundles and VSIX packages are ignored by Git.

For behavior changes, cover the relevant Git or VS Code interaction. Preserve user-owned code, notes, and review state, and keep comparisons explicit. Test staged and unstaged versions separately when changing Git reads. Keep instruction changes compatible with both agents.

## Pull requests

Describe the problem, the resulting behavior, and the checks you ran. Include screenshots for visible UI changes when useful. Use a Conventional Commit PR title: `fix:` for a patch, `feat:` for a feature, or `feat!:` for a breaking change. Use `docs:`, `test:`, or `ci:` for non-release work. Squash merges must preserve that title. Explain breaking changes in the commit body. semantic-release generates release notes and the packaged changelog; do not manually bump versions or create routine release tags. Avoid including repository-specific guides, private code, tokens, or personal machine paths in fixtures and documentation.

For bugs, include the extension and VS Code versions, operating system, scope type, and a small reproduction. Redact private repository content before sharing a guide or diff.
