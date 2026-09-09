# Automated releases

AGR uses semantic-release. Conventional Commits on `main` determine the next version and release notes; CI packages the extension, publishes it to the VS Code Marketplace, and creates a GitHub release with the same VSIX. There is no npm package publication and no routine manual version bump or tag creation.

## One-time setup

1. Create `https://github.com/dmitry-zaets/agr` with `main` as the default branch and push the prepared source. Update manifest/documentation URLs if choosing another owner or repository.
2. Verify control of the Marketplace publisher ID `dmitry-zaets`. Register it if available, or update `extension/package.json` before the first public release.
3. Add a repository Actions secret named `VSCE_PAT` with a Marketplace publishing credential. `GITHUB_TOKEN` is provided by GitHub Actions. The release job requires Marketplace credentials and fails clearly if missing, instead of silently creating a GitHub-only release.
4. Set the repository Actions variable `RELEASE_ENABLED` to `true` when ready to publish. Until then, CI runs normally and skips the release job.
5. Enable squash merges and use the PR title as the squash commit title. Require the `verify` check before merging to `main`. Direct commits must also follow Conventional Commits.
6. Once the listing is live, replace the root README's publication-preparation sentence with its Marketplace link.

Use Microsoft's [publisher and authentication instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) to configure the account. This workflow currently uses `VSCE_PAT`; Microsoft documents retirement of global Azure DevOps PATs on December 1, 2026. Before then, migrate the release job to Entra workload identity, add an Azure login step, and use `VSCE_AZURE_CREDENTIAL=true` instead of the PAT. The [VS Code release plugin](https://github.com/felipecrs/semantic-release-vsce) supports both authentication modes.

The first semantic release defaults to **1.0.0** when there is a releasable commit and no previous release tag. `0.3.0` in the source manifest identifies the local prototype build; it does not seed the automated release history. If a version was actually published before enabling automation, its matching release tag must identify that release's commit. Do not fabricate a release tag just to influence version selection.

## Commit conventions

| Commit | Result |
| --- | --- |
| `fix: preserve reviewed state` | Patch release |
| `perf: reduce Git reads` | Patch release |
| `feat: add a scope picker` | Minor release |
| `feat!: change the guide format` | Major release |
| A `BREAKING CHANGE:` footer | Major release |
| `docs:`, `test:`, `ci:`, `chore:` | No release by default |

The largest required bump among commits since the last release wins. PR titles are validated in CI; squash merging makes that title the commit semantic-release analyzes. Include breaking-change migration details in the commit body.

## Pipeline

Every pull request and push to `main` runs type-checks, core/release-rule tests, portable skill consistency checks, VS Code integration tests, and VSIX packaging. The verification job uploads a development VSIX.

After verification passes on `main`, a separate serialized release job fetches the full Git history and runs `npm run release`. It analyzes commits, generates notes and the packaged changelog, sets the extension version, and rebuilds the VSIX. It then publishes the package to Marketplace and attaches `agr.vsix` to a tagged GitHub release. PR jobs have read-only permissions and receive no publishing credentials. Release jobs can write repository contents; automatic PR/issue comments are disabled.

The workflow can also be dispatched manually on `main` to check for pending releases. A release is only produced when commit analysis calls for one. The root/core packages stay private, and generated release version/changelog changes are not committed back to `main`. Git tags and GitHub release notes are the release history; rebuilding an old tag directly uses the source's development version, not the version injected during its release job.

## Local checks

Use a current Node 22 release (22.14+), or Node 24.10+. `.nvmrc` selects Node 22.

```sh
npm ci
npm run check
npm run test:extension
npm run package
```

On headless Linux, use `xvfb-run -a npm run test:extension`. Local packaging keeps the source manifest's development version. The release job supplies the published version.

After repository and credential setup, `npm run release -- --dry-run` previews the version and notes. This still verifies remote push/publishing permissions, and skips prepare/publish hooks; it is not a replacement for a packaging check. Never run a real release locally as a packaging test.

## Failed publication

Marketplace and GitHub publication are separate operations. If one fails after a tag or Marketplace upload succeeded, inspect those destinations before retrying. The workflow preserves a prepared VSIX as `agr-release-recovery` when possible. Re-running semantic-release after a tag has been created may report no new release rather than completing the missing upload. Recover the exact version using the preserved artifact and the semantic-release logs; do not delete successful releases or bump a version blindly.

## Package assets

`extension/media/icon.png` is the 256×256 Marketplace icon. Its vector source is `docs/assets/marketplace-icon.svg`; regenerate it with `rsvg-convert -o extension/media/icon.png docs/assets/marketplace-icon.svg`. The separate activity-bar SVG remains theme-aware. See the [extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest).

Configuration lives in [release.config.mjs](../release.config.mjs) and [.github/workflows/ci.yml](../.github/workflows/ci.yml). See the [semantic-release configuration reference](https://semantic-release.org/usage/configuration/) for branch, tag, and plugin behavior.
