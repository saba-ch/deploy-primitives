// 3. Fingerprint: a unit's built file plus name@version of every package it imports. Needs only the
// build, so a deploy where nothing changed stops before copying any packages.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pkgName } from '../util.ts';
import type { Built } from './build.ts';
import type { Unit } from './index.ts';
import type { PlatformPkgs } from './packages.ts';

/** name → version(s) of every npm package the build imports, read from the files esbuild resolved. */
async function importedVersions(built: Built, platform: PlatformPkgs) {
  const versions = new Map<string, Set<string>>();
  for (const [name, p] of Object.entries(platform)) versions.set(name, new Set([p.version]));
  for (const entry of built.externalEntries) {
    // nearest package.json with a name: some packages ship nameless ones (e.g. dist/{"type":"module"})
    for (let dir = dirname(entry); dir !== '/'; dir = dirname(dir)) {
      const pkg = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse, () => null);
      if (!pkg?.name) continue;
      if (!versions.has(pkg.name)) versions.set(pkg.name, new Set());
      versions.get(pkg.name)!.add(pkg.version);
      break;
    }
  }
  return (name: string) => [...(versions.get(name) ?? ['?'])].sort().join('|');
}

export async function fingerprint(repoDir: string, units: Unit[], built: Built, platform: PlatformPkgs) {
  const version = await importedVersions(built, platform);
  for (const u of units) {
    const out = built.metafile.outputs[relative(repoDir, built.files[u.id])];
    const pkgs = new Set(out.imports.filter((i) => i.external).map((i) => pkgName(i.path)).filter((n): n is string => !!n));
    const deps = [...pkgs].map((n) => `${n}@${version(n)}`);
    const hash = createHash('sha256');
    hash.update(await readFile(built.files[u.id]));
    hash.update(deps.sort().join(','));
    u.fingerprint = hash.digest('hex').slice(0, 16);
  }
}
