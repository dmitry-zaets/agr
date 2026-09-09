export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/changelog', { changelogFile: 'extension/CHANGELOG.md' }],
    ['./scripts/semantic-release-vsce.mjs', { packageRoot: 'extension', packageVsix: 'agr.vsix' }],
    ['@semantic-release/github', {
      assets: [{ path: 'agr.vsix', label: 'AGR VS Code extension' }],
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
      addReleases: false,
    }],
  ],
};
