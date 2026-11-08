#!/usr/bin/env node
/** Copy the canonical browser application into the legacy docs/ static mirror.
 * Documentation-only files already in docs/ are preserved.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'public');
const destination = path.join(root, 'docs');

function copyDirectory(relative = '') {
  const from = path.join(source, relative);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // Never publish local credentials, keys, or recordings placed in public/.
    if (entry.isSymbolicLink() || /^\.env(?:\.|$)/i.test(entry.name) ||
        /\.(?:pem|key|wav|webm)$/i.test(entry.name)) {
      throw new Error(`Unexpected non-public file in public/${path.join(relative, entry.name)}`);
    }
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) copyDirectory(child);
    else if (entry.isFile()) {
      const target = path.join(destination, child);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, child), target);
    }
  }
}

copyDirectory();
fs.writeFileSync(path.join(destination, '.nojekyll'), '');
console.log('Static site synchronized from public/ to docs/.');
