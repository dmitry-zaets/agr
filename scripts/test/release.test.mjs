import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { isConventionalTitle } from '../check-pr-title.mjs';
import config from '../../release.config.mjs';

const options = config.plugins.find(([name]) => name === '@semantic-release/commit-analyzer')[1];
const logger = { log() {} };

test('release rules distinguish fixes, features, breaking changes, and documentation', async () => {
  for (const [message, expected] of [
    ['fix: preserve reviewed state', 'patch'],
    ['feat(scope): review staged changes', 'minor'],
    ['feat!: change guide format', 'major'],
    ['refactor: change parser\n\nBREAKING CHANGE: old guides need migration', 'major'],
    ['docs: clarify installation', null],
    ['ci: improve checks', null],
  ]) {
    assert.equal(await analyzeCommits(options, { cwd: process.cwd(), commits: [{ message, hash: 'abc123' }], logger }), expected, message);
  }
});

test('PR title check supports scopes and breaking changes and rejects missing commit types', () => {
  for (const title of ['fix: preserve progress', 'feat(ui)!: replace sidebar', 'docs: explain setup']) assert.ok(isConventionalTitle(title));
  for (const title of ['Update things', 'feat:', 'feat: \nextra', 'unknown: change']) assert.ok(!isConventionalTitle(title));
});
