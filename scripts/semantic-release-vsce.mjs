import path from 'node:path';
import { readFile } from 'node:fs/promises';
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

// Use the same role-assignment check as vsce, without the SDK's preceding
// OPTIONS discovery request, which can hang at /_apis/securityroles.
export async function verifyMarketplacePat(publisher, pat, request = fetch) {
  const url = `https://marketplace.visualstudio.com/_apis/securityroles/scopes/gallery.publisher/roleassignments/resources/${encodeURIComponent(publisher)}?api-version=3.2-preview.1`;
  let response;
  try {
    response = await request(url, {
      headers: { Authorization: `Basic ${Buffer.from(`OAuth:${pat}`).toString('base64')}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Marketplace publisher verification could not complete within 30 seconds or the connection failed. Token validity remains unknown.');
  }
  if (!response.ok) throw new Error(`Marketplace publisher verification returned HTTP ${response.status}. Publishing is blocked.`);
  const result = await response.json();
  if (!Array.isArray(result.value)) throw new Error('Marketplace verification returned an unexpected response. Publishing is blocked.');
}

export async function verifyConditions(config, context) {
  const directory = path.resolve(context.cwd, config.packageRoot ?? '.');
  if (config.publish === false || !process.env.VSCE_PAT) {
    return inDirectory(directory, () => verifyVsce(config, context));
  }
  // Retain the plugin's package/target validation and prepare/publish lifecycle.
  await inDirectory(directory, () => verifyVsce({ ...config, publish: false }, context));
  const { publisher } = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  context.logger.log('Verifying Marketplace publisher permissions directly');
  await verifyMarketplacePat(publisher, process.env.VSCE_PAT);
  context.logger.log('Marketplace publisher authentication succeeded');
}
