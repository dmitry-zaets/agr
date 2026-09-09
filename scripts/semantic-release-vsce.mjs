import path from 'node:path';
import { verifyConditions as verifyVsce } from 'semantic-release-vsce';
export { prepare, publish } from 'semantic-release-vsce';

// semantic-release-vsce's authentication hook ignores packageRoot and reads
// process.cwd(). Keep this workaround confined to that hook; other plugins
// still need the monorepo root for their assets and changelog paths.
export async function inDirectory(directory, action) {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    return await action();
  } finally {
    process.chdir(previous);
  }
}

export async function verifyConditions(config, context) {
  return inDirectory(path.resolve(context.cwd, config.packageRoot ?? '.'),
    () => verifyVsce(config, context));
}
