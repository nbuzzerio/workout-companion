#!/usr/bin/env python3
"""Real Nginx integration using Docker, local temp files only. No Droplet access."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request

repository = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repository / 'infra'))
from deploy_static import Releases
parser = argparse.ArgumentParser()
parser.add_argument('--nginx', help='Use a local Nginx binary instead of Docker (isolated temp prefix, no system configuration)')
options = parser.parse_args()
manifest = json.loads((repository / 'dist/release.json').read_text())
slug = manifest['appId']
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    root.chmod(0o755)  # Container Nginx workers must traverse the bind mount.
    for directory in ('apps', 'incoming', 'releases'):
        (root / directory).mkdir()
    shutil.copytree(repository / 'dist', root / 'incoming' / slug / manifest['release'])
    # Verify the actual build passes activation, including the production symlink layout.
    Releases(root).activate(slug, manifest['release'])
    shutil.copyfile(repository / 'infra/nginx/personal-apps.conf', root / 'apps.conf')
    (root / 'default.conf').write_text('server { listen 80; server_name localhost; include /etc/nginx/personal-apps.conf; location / { return 200 "existing site"; } }')
    security_headers = {
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
    }
    header_text = '\n'.join(f'add_header {name} "{value}" always;' for name, value in security_headers.items())
    (root / 'security.conf').write_text(header_text)
    # The host parent and both app locations use the same reviewed policy.
    (root / 'default.conf').write_text((root / 'default.conf').read_text().replace('server_name localhost;', 'server_name localhost; ' + header_text))
    container = None
    process = None
    if options.nginx:
        # Change only filesystem roots; the actual location/routing directives are unchanged.
        (root / 'apps.conf').write_text((root / 'apps.conf').read_text().replace('/srv/personal-apps', root.as_posix()).replace('/etc/nginx/snippets/personal-apps-security-headers.conf', str(root / 'security.conf')))
        with socket.socket() as connection:
            connection.bind(('127.0.0.1', 0)); port = str(connection.getsockname()[1])
        temp_paths = ' '.join(f'{kind}_temp_path {root}/{kind};' for kind in ('client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'))
        mime_types = 'types { text/html html; text/css css; application/javascript js; image/png png; application/manifest+json webmanifest; application/json json; }'
        (root / 'nginx.conf').write_text(f'pid {root}/nginx.pid; error_log stderr; events {{}} http {{ {temp_paths} {mime_types} access_log off; default_type application/octet-stream; server {{ listen 127.0.0.1:{port}; {header_text} include {root}/apps.conf; location / {{ return 200 "existing site"; }} }} }}')
        subprocess.run([options.nginx, '-t', '-p', str(root), '-c', str(root / 'nginx.conf')], check=True)
        process = subprocess.Popen([options.nginx, '-p', str(root), '-c', str(root / 'nginx.conf'), '-g', 'daemon off;'])
    else:
        command = ['docker', 'run', '--rm', '-d', '-p', '127.0.0.1::80',
                   '-v', f'{root.as_posix()}:/srv/personal-apps:ro',
                   '-v', f'{(root / "security.conf").as_posix()}:/etc/nginx/snippets/personal-apps-security-headers.conf:ro',
                   '-v', f'{(root / "apps.conf").as_posix()}:/etc/nginx/personal-apps.conf:ro',
                   '-v', f'{(root / "default.conf").as_posix()}:/etc/nginx/conf.d/default.conf:ro', 'nginx:1.28.0-alpine']
        container = subprocess.check_output(command, text=True).strip()
        port = subprocess.check_output(['docker', 'port', container, '80/tcp'], text=True).strip().rsplit(':', 1)[1]
    try:
        origin = f'http://127.0.0.1:{port}'
        def request(path):
            try:
                with urllib.request.urlopen(origin + path, timeout=5) as response:
                    return response.status, response.read(), response.headers
            except urllib.error.HTTPError as error:
                return error.code, error.read(), error.headers
        for attempt in range(30):
            try:
                request('/'); break
            except OSError:
                time.sleep(0.2)
        assert request('/')[1] == b'existing site'
        base = f'/apps/{slug}/'
        status, html, headers = request(base)
        assert status == 200 and b'<div id="root">' in html
        assert headers['Cache-Control'] == 'no-cache'
        assert headers['Content-Type'] == 'text/html'
        assert request(base + 'settings')[1] == html
        assert request(base + 'deep/nested/path')[1] == html
        asset = next(name for name in manifest['files'] if name.startswith('assets/') and name.endswith('.js'))
        assert request(base + asset)[0] == 200
        assert request(base + asset)[2]['Content-Type'] in ('application/javascript', 'text/javascript')
        assert request(base + 'sw.js')[0] == 200
        for path in ['/apps/', f'/apps/missing-{slug}/settings', '/apps/Bad/settings', '/apps/bad--slug/', '/apps/' + 'a' * 49 + '/',
                     base + 'assets/missing.js', base + 'missing.png', base + '.env', base + 'folder/.secret', base.rstrip('/')]:
            assert request(path)[0] == 404, path
        for path in ['/', base, base + 'settings', base + asset, base + 'sw.js', base + 'assets/missing.js']:
            for name, value in security_headers.items():
                assert request(path)[2].get(name) == value, (path, name)
        print('Nginx: existing site, SPA deep links, static assets, cache headers, unknown apps and invalid paths passed.')
    finally:
        if container:
            subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
        if process:
            process.terminate(); process.wait(timeout=10)
