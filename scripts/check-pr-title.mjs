import { pathToFileURL } from 'node:url';

export function isConventionalTitle(title) {
  return /^(feat|fix|perf|revert|docs|style|refactor|test|build|ci|chore)(\([^()\r\n]+\))?!?: \S[^\r\n]*$/.test(title);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!isConventionalTitle(process.env.PR_TITLE ?? '')) {
    console.error('Use a Conventional Commit PR title, e.g. feat: add review navigation, fix: preserve progress, or docs: improve setup.');
    process.exitCode = 1;
  }
}
