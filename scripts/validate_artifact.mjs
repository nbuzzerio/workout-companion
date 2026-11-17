import fs from 'node:fs';
import path from 'node:path';
import { Releases } from '../infra/deploy_static.mjs';

export function validateArtifact(artifact = path.resolve(import.meta.dirname, '../dist')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'release.json'), 'utf8'));
  return new Releases(path.dirname(artifact)).validate(artifact, manifest.appId, manifest.release);
}
if (import.meta.main) {
  const manifest = validateArtifact();
  console.log(`Validated artifact ${manifest.appId} / ${manifest.release}`);
}
