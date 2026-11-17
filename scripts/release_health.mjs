import fs from 'node:fs';
import { validateRelease, validateSlug } from '../infra/deploy_static.mjs';

export function previousRelease(activation) {
  // Missing/malformed activation output must not silently disable rollback.
  if (!Object.hasOwn(activation, 'previous')) throw new Error('Missing previous release');
  return activation.previous === null || activation.previous === '' ? '' : validateRelease(activation.previous);
}
export function checkRelease(manifest, slug, release) {
  validateSlug(slug); validateRelease(release);
  if (manifest?.appId !== slug || manifest.release !== release) throw new Error('Public release identity mismatch');
}
if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'previous' && args.length === 0) console.log(previousRelease(JSON.parse(fs.readFileSync(0, 'utf8'))));
  else if (mode === 'check' && args.length === 3) checkRelease(JSON.parse(fs.readFileSync(args[0], 'utf8')), args[1], args[2]);
  else throw new Error('Usage: release_health.mjs previous | check FILE SLUG RELEASE');
}
