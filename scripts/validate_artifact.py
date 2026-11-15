"""Validate the actual local/CI build using the unchanged deployment validator."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'infra'))
from deploy_static import Releases

artifact = root / 'dist'
manifest = json.loads((artifact / 'release.json').read_text())
Releases(root).validate(artifact, manifest['appId'], manifest['release'])
print(f"Validated artifact {manifest['appId']} / {manifest['release']}")
