import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function check() {
  const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(manifest.permissions, ['storage', 'sidePanel', 'scripting', 'webRequest']);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src https://www.zhipin.com/wapi/zpgeek/job/detail.json");
  assert.deepEqual(manifest.host_permissions, ['https://www.zhipin.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  assert.equal(manifest.content_scripts[0].all_frames, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else files.push(path);
    }
  }
  await walk(join(root, 'extension'));
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(source, /\b(?:XMLHttpRequest|WebSocket|eval)\s*\(|chrome\.storage\.sync\b/);
      if (path !== join(root, 'extension/core/job-api.js')) assert.doesNotMatch(source, /\bfetch\s*\(/);
      else {
        assert.match(source, /const JOB_ENDPOINT = 'https:\/\/www\.zhipin\.com\/wapi\/zpgeek\/job\/detail\.json';/);
        assert.doesNotMatch(source, /console\.|storage\.(?:local|session)|\.cookie/);
      }
    }
    if (path.endsWith('.html')) {
      assert.doesNotMatch(source, /<script[^>]*src=["']https?:|\son\w+\s*=/i);
      for (const match of source.matchAll(/(?:src|href)="([^"#]+)"/g)) await readFile(join(root, 'extension', match[1]));
    }
  }
  for (const relative of [manifest.background.service_worker, ...manifest.content_scripts[0].js, manifest.side_panel.default_path]) {
    assert.ok(resolve(root, 'extension', relative).startsWith(resolve(root, 'extension')));
    await readFile(join(root, 'extension', relative));
  }
  for (const relative of ['content.js', 'recovery-begin.js', 'core/identity.js', 'core/parser.js', 'core/page-state.js', 'core/rest.js', 'core/job-parser.js']) {
    const source = await readFile(join(root, 'extension', relative), 'utf8');
    assert.doesNotMatch(source, /\.(?:append|appendChild|prepend|remove|replaceChildren|insertBefore|insertAdjacentHTML|setAttribute|click|submit)\s*\(|(?:innerHTML|outerHTML|textContent|innerText)\s*=/);
    assert.doesNotMatch(source, /history\.(?:pushState|replaceState)|\.cookie|localStorage|storage\.(?:local|sync)|\.value\b/);
  }
  const panelSource = await readFile(join(root, 'extension/panel.js'), 'utf8');
  assert.match(panelSource, /import '\.\/core\/rest\.js';/, 'panel must import core/rest.js for restLabel');
  const reconnectSource = await readFile(join(root, 'extension/core/reconnect.js'), 'utf8');
  assert.match(reconnectSource, /'core\/rest\.js'/, 'recovery injection must include core/rest.js');
  assert.ok(manifest.content_scripts[0].js.includes('floating.js'), 'regular pages must load floating controls');
  assert.match(reconnectSource, /'floating\.js'/, 'recovery must load the same floating controls');
  assert.ok(manifest.content_scripts[0].js.includes('core/sound.js'), 'regular pages load sound lifecycle');
  assert.match(reconnectSource, /'core\/sound\.js'/, 'recovery loads sound lifecycle');
  assert.ok(manifest.content_scripts[0].js.includes('core/job-parser.js'), 'regular pages load job parsing');
  assert.match(reconnectSource, /'core\/job-parser\.js'/, 'recovery loads job parsing');
  const floatingSource = await readFile(join(root, 'extension/floating.js'), 'utf8');
  assert.match(floatingSource, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(floatingSource, /document\.(?:querySelector|querySelectorAll|getElementById)|\.innerHTML\s*=|chrome\.storage\b|localStorage/);
  console.log(`Static checks passed: ${files.length} extension files, permissions, syntax, resource references and read-only content path.`);
  return { root, files, version: manifest.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await check();
