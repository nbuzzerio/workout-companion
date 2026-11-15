"""Conservative admission checks for trusted uploads; NOT a quota or transfer cap."""
import json
import os
from pathlib import Path
import stat

POLICY = Path('/etc/personal-apps/storage.json')
DEFAULT_RESERVE_BYTES = 3 * 1024 ** 3
MAX_RELEASE_BYTES = 100 * 1024 ** 2
MAX_MANIFEST_BYTES = 2 * 1024 ** 2
MAX_RELEASE_FILES = 10000
SAFETY_BYTES = 64 * 1024 ** 2


def require_storage(root, phase='upload', policy_path=POLICY):
    if phase not in ('upload', 'activation'):
        raise ValueError('Unknown storage check phase')
    reserve = DEFAULT_RESERVE_BYTES
    if policy_path.exists() or policy_path.is_symlink():
        info = policy_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Storage policy must be a root-owned regular file, not group/world writable')
        policy = json.loads(policy_path.read_text())
        if not isinstance(policy, dict) or set(policy) != {'minFreeBytes'}:
            raise ValueError('Expected storage policy with minFreeBytes only')
        reserve = policy['minFreeBytes']
        if type(reserve) is not int or reserve <= 0:
            raise ValueError('minFreeBytes must be a positive integer byte count')
    root = Path(root)
    for name in ('apps', 'releases', 'incoming'):
        path = root / name
        if path.is_symlink() or path.stat().st_dev != root.stat().st_dev:
            raise ValueError('Deployment directories must use the checked filesystem')
    # f_bavail excludes blocks reserved for root. Locks coordinate our operations,
    # but other host users can still consume space after this observation.
    space = os.statvfs(root)
    available = space.f_bavail * space.f_frsize
    copies = 2 if phase == 'upload' else 1
    required = reserve + copies * (MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES) + SAFETY_BYTES
    required_inodes = 10000 + copies * (MAX_RELEASE_FILES + 1)
    if available < required or space.f_favail < required_inodes:
        raise ValueError(f'Insufficient free space for {phase}: available={available}, required={required}, freeInodes={space.f_favail}, requiredInodes={required_inodes}')
    return {'phase': phase, 'availableBytes': available, 'requiredBytes': required,
            'minFreeBytes': reserve}
