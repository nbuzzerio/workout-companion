import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appConfig } from '../config/app.ts';
const release = process.env.RELEASE_ID ?? 'local';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(release))
  throw new Error('Invalid release ID');
async function inventory(
  dir: string,
  prefix = '',
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden');
    if (entry.isDirectory())
      Object.assign(
        result,
        await inventory(join(dir, entry.name), `${relative}/`),
      );
    else if (relative !== 'release.json')
      result[relative] = createHash('sha256')
        .update(await readFile(join(dir, entry.name)))
        .digest('hex');
  }
  return result;
}
await writeFile(
  'dist/release.json',
  JSON.stringify(
    {
      formatVersion: 1,
      appId: appConfig.id,
      basePath: appConfig.basePath,
      release,
      files: await inventory('dist'),
    },
    null,
    2,
  ),
);
console.log(`Packaged ${appConfig.id} release ${release}`);
