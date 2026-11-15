"""Discover an ED25519 public host key, then authenticate it against a pinned hash.

No trust-on-first-use: nothing is written until the entire scan is validated.
Only the public host key is handled here. The pin must come from a trusted channel.
"""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile


def validate_target(host, port, fingerprint):
    if (not isinstance(host, str) or len(host) > 253 or
            not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                    for label in host.split('.'))):
        raise ValueError('DEPLOY_HOST must be a DNS hostname or IPv4 address')
    if not re.fullmatch(r'[1-9][0-9]{0,4}', str(port)) or not 1 <= int(port) <= 65535:
        raise ValueError('DEPLOY_PORT must be explicitly set to 1..65535')
    if not isinstance(fingerprint, str) or not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', fingerprint):
        raise ValueError('DEPLOY_HOST_FINGERPRINT must be an unpadded SHA256 fingerprint')
    digest = base64.b64decode(fingerprint[7:] + '=', validate=True)
    if base64.b64encode(digest).decode().rstrip('=') != fingerprint[7:]:
        raise ValueError('Noncanonical SHA256 fingerprint')


def verified_known_hosts(scan, host, port, fingerprint):
    validate_target(host, port, fingerprint)
    if not isinstance(scan, str) or len(scan) > 65536:
        raise ValueError('Invalid or oversized host-key discovery response')
    target = host if int(port) == 22 else f'[{host}]:{port}'
    keys = set()
    for line in scan.splitlines():
        if line.startswith('#') or not line.strip():
            continue
        fields = line.split()
        if len(fields) != 3 or fields[0] != target or fields[1] != 'ssh-ed25519':
            raise ValueError('Malformed or unexpected host-key entry')
        try:
            blob = base64.b64decode(fields[2], validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError('Malformed public host-key encoding') from error
        # SSH wire format: string algorithm, string 32-byte ED25519 public key.
        prefix = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32)
        if (len(blob) != len(prefix) + 32 or not blob.startswith(prefix) or
                base64.b64encode(blob).decode() != fields[2]):
            raise ValueError('Malformed ED25519 public host-key blob')
        keys.add(blob)
    if len(keys) != 1:
        raise ValueError('Missing or ambiguous ED25519 host key')
    blob = keys.pop()
    actual = 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')
    if not hmac.compare_digest(actual, fingerprint):
        raise ValueError('Discovered host key does not match the pinned SHA256 fingerprint')
    return f'{target} ssh-ed25519 {base64.b64encode(blob).decode()}\n'


def discover(host, port, fingerprint, destination):
    validate_target(host, port, fingerprint)
    result = subprocess.run(['ssh-keyscan', '-T', '10', '-p', str(port), '-t', 'ed25519', host],
                            capture_output=True, text=True, timeout=30, check=True)
    verified = verified_known_hosts(result.stdout, host, port, fingerprint)
    destination = Path(destination)
    descriptor, temporary = tempfile.mkstemp(prefix='.known-hosts-', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='ascii', newline='\n') as handle:
            handle.write(verified)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    try:
        discover(os.environ['DEPLOY_HOST'], os.environ['DEPLOY_PORT'],
                 os.environ['DEPLOY_HOST_FINGERPRINT'], Path.home() / '.ssh/known_hosts')
    except (KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Host-key verification failed: {error}')
