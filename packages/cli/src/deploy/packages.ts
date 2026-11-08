// 4. Packages: nf3 traces the built files and copies only the packages they use, native binaries
// included. @mastra/core and zod are left out: every thread gets the platform's copy.
import { findPackageJSON } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { traceNodeModules } from 'nf3';
import { CliError, PLATFORM_PKGS } from '../util.ts';
import type { Built } from './build.ts';

/** The repo's own copy of each platform package: where it is and which version. */
export type PlatformPkgs = Record<string, { dir: string; version: string }>;

export async function platformPkgs(repoDir: string): Promise<PlatformPkgs> {
  const base = pathToFileURL(join(repoDir, 'package.json'));
  const found: PlatformPkgs = {};
  for (const name of PLATFORM_PKGS) {
    const pkgJson = findPackageJSON(name, base);
    if (!pkgJson) continue;
    found[name] = { dir: await realpath(dirname(pkgJson)), version: JSON.parse(await readFile(pkgJson, 'utf8')).version };
  }
  if (!found['@mastra/core']) throw new CliError('packages: this repo does not depend on @mastra/core');
  return found;
}

export async function tracePackages(repoDir: string, built: Built, platform: PlatformPkgs) {
  const skip = Object.values(platform).map((p) => p.dir.slice(1) + '/'); // nft paths are relative to base '/'
  const layout = await traceNodeModules([...Object.values(built.files), ...built.externalEntries], {
    rootDir: repoDir,
    outDir: built.outdir,
    nft: { base: '/', ignore: (p: string) => skip.some((s) => p.startsWith(s)) },
  });
  for (const name of PLATFORM_PKGS) {
    const pkg = layout.packages[name];
    if (pkg) {
      const where = Object.values(pkg.versions).map((v) => v.path).join(', ');
      throw new CliError(`packages: ${name} must come from the platform, but the deploy carries its own copy (${where}). Remove the package that bundles it, or make ${name} a peer dependency of it.`);
    }
  }
}
