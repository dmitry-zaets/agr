#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotRepository } from './git';
import { parseGuide, validateCoverage } from './model';
import { snapshotForGuide, snapshotScope } from './scope';

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
  if (!['snapshot', 'validate'].includes(command)) throw new Error('Usage: node agr.cjs snapshot <repo> [output.json] | validate <repo> [guide.json]');
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
    const guide = parseGuide(await readFile(output ? path.resolve(output) : path.join(root, 'agr.json'), 'utf8'));
    const snapshot = await snapshotForGuide(root, guide);
    const result = validateCoverage(guide, snapshot);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.baseMatches || result.missing.length || result.unknown.length || result.invalidSelections.length) process.exitCode = 1;
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
