#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotRepository } from './git';
import { validateCoverage } from './model';
import { snapshotForGuide, snapshotScope } from './scope';
import { listReviews } from './reviews';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scopeFlag = args.indexOf('--scope');
  let scopeFile: string | undefined;
  if (scopeFlag >= 0) {
    scopeFile = args[scopeFlag + 1];
    if (!scopeFile) throw new Error('--scope requires a JSON file.');
    args.splice(scopeFlag, 2);
  }
  const [command, directory = '.', output] = args;
  if (!['snapshot', 'validate'].includes(command)) throw new Error('Usage: node agr.cjs snapshot <repo> [output.json] | validate <repo> [review-name.json]');
  if (command === 'snapshot') {
    const snapshot = scopeFile
      ? await snapshotScope(path.resolve(directory), JSON.parse(await readFile(path.resolve(scopeFile), 'utf8')))
      : await snapshotRepository(path.resolve(directory));
    const text = JSON.stringify(snapshot, null, 2) + '\n';
    if (output) await writeFile(path.resolve(output), text, { flag: 'w' });
    else process.stdout.write(text);
  } else {
    if (scopeFile) throw new Error('validate reads scope from the guide; do not pass --scope.');
    const { repositoryRoot } = await import('./git');
    const root = await repositoryRoot(path.resolve(directory));
    const reviews = await listReviews(root);
    const file = output && (output.startsWith('.agr/') ? output.slice(5) : output);
    if (file && (path.basename(file) !== file || !file.endsWith('.json'))) throw new Error('Pass a review filename inside .agr/, such as checkout.json.');
    const selected = file ? reviews.filter(review => review.file === file) : reviews;
    if (!selected.length) throw new Error(file ? `Review .agr/${file} not found.` : 'No reviews found. Create .agr/<name>.json first.');
    const results = [];
    for (const review of selected) {
      try {
        if (!review.guide) throw new Error(review.error);
        const snapshot = await snapshotForGuide(root, review.guide);
        const result = validateCoverage(review.guide, snapshot);
        results.push({ file: `.agr/${review.file}`, ...result });
        if (!result.baseMatches || result.missing.length || result.unknown.length || result.invalidSelections.length || result.invalidComments.length || result.multiFileSteps.length) process.exitCode = 1;
      } catch (error) {
        results.push({ file: `.agr/${review.file}`, error: (error as Error).message });
        process.exitCode = 1;
      }
    }
    process.stdout.write(JSON.stringify({ reviews: results }, null, 2) + '\n');
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
