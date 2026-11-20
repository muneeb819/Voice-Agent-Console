/**
 * deploy/nginx-free-port80.py: when another web server (e.g. Caddy) owns TCP 80,
 * the installer moves ONLY nginx's idle distro default site to 127.0.0.1:8080.
 * Covers the Amazon Linux 2023 case where the listen lines were commented out
 * (a server block with no listen line still defaults to *:80).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helper = path.join(__dirname, '..', 'deploy', 'nginx-free-port80.py');
if (spawnSync('python3', ['--version']).status !== 0) {
  console.log('SKIP installer port-80 checks: python3 not available');
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-port80-'));
const backups = path.join(dir, 'backups');
const run = (file: string) => execFileSync('python3', [helper, file], { env: { ...process.env, VAC_NGINX_BACKUP_DIR: backups } }).toString();
const write = (name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const activeListens = (text: string) => text.split('\n').map((l) => l.split('#')[0]).filter((l) => /^\s*listen\s/.test(l)).map((l) => l.trim());

const al2023Commented = write('al2023.conf', `http {
    include /etc/nginx/conf.d/*.conf;
    server {
#        listen       80;
#        listen       [::]:80;
        server_name  _;
        root         /usr/share/nginx/html;
        location / {
        }
    }
#    server {
#        listen       443 ssl;
#    }
}
`);
run(al2023Commented);
assert.deepEqual(activeListens(fs.readFileSync(al2023Commented, 'utf8')), ['listen 127.0.0.1:8080;'], 'block with no listen line gets an explicit loopback listen');
console.log('✓ Amazon Linux 2023 default site with commented listen lines moved to 127.0.0.1:8080');

const al2023Plain = write('al2023-plain.conf', `http {
    server {
        listen       80;
        listen       [::]:80;
        server_name  _;
    }
}
`);
run(al2023Plain);
assert.deepEqual(activeListens(fs.readFileSync(al2023Plain, 'utf8')), ['listen 127.0.0.1:8080;']);
console.log('✓ Default site listening on 80 and [::]:80 moved to 127.0.0.1:8080');

const debian = write('default', `server {
\tlisten 80 default_server;
\tlisten [::]:80 default_server;
\t# listen 443 ssl default_server;
\troot /var/www/html;
\tserver_name _;
\tlocation / {
\t\ttry_files $uri $uri/ =404;
\t}
}
`);
const debianOut = run(debian);
assert.deepEqual(activeListens(fs.readFileSync(debian, 'utf8')), ['listen 127.0.0.1:8080;']);
assert.match(debianOut, /backup:/);
const backupFiles = fs.readdirSync(backups);
assert.equal(backupFiles.length >= 1, true, 'backup written');
assert.ok(!backupFiles.some((f) => f.endsWith('default')) || !fs.existsSync(path.join(dir, 'default.vac-port80.bak')), 'no backup left next to the include directory');
console.log('✓ Debian/Ubuntu default site moved; backup kept outside nginx include folders');

const keep = write('keep.conf', `server {
    listen 80;
    listen 443 ssl;
    server_name keep.me;
}
server {
    listen 533 ssl;
    location / { proxy_pass http://127.0.0.1:534; }
}
`);
const before = fs.readFileSync(keep, 'utf8');
run(keep);
assert.equal(fs.readFileSync(keep, 'utf8'), before, 'servers that also listen elsewhere (443, the console on 533) are never touched');
console.log('✓ Console (:533) and real sites (80+443) are left untouched');

const snapshot = fs.readFileSync(al2023Plain, 'utf8');
run(al2023Plain);
assert.equal(fs.readFileSync(al2023Plain, 'utf8'), snapshot, 'second run is a no-op');
console.log('✓ Re-running is a no-op');
console.log('ALL INSTALLER PORT-80 CHECKS PASSED');
