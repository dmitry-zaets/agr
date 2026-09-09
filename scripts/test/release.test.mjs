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


test('Marketplace verification uses the extension directory and restores cwd on success and failure', async () => {
  const { inDirectory } = await import('../semantic-release-vsce.mjs');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const previous = process.cwd();
  const directory = path.join(previous, 'extension');
  const version = await inDirectory(directory, async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    return manifest.engines.vscode;
  });
  assert.equal(version, '^1.95.0');
  assert.equal(process.cwd(), previous);
  await assert.rejects(inDirectory(directory, async () => { throw new Error('verification failed'); }), /verification failed/);
  assert.equal(process.cwd(), previous);
});
