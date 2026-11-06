import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { check } from './check.js';
const { root, files, version } = await check();
const destination = join(root, 'dist', 'boss-helper');
await mkdir(destination, { recursive: true });
await cp(join(root, 'extension'), destination, { recursive: true });
const hashes = [];
for (const path of files.sort()) {
  const bytes = await readFile(path);
  const relative = path.substring(join(root, 'extension').length + 1).replaceAll('\\', '/');
  const built = await readFile(join(destination, relative));
  if (!bytes.equals(built)) throw new Error(`Build mismatch: ${relative}`);
  hashes.push(`${createHash('sha256').update(bytes).digest('hex')}  ${relative}`);
}
await writeFile(join(root, 'dist', 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`Built v${version}: ${destination} (${files.length} files; hashes verified).`);
