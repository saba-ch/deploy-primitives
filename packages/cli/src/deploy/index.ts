// mastra-platform deploy
//   1 index        find the units
//   2 build        one esbuild call, one file per unit
//   3 fingerprint  per unit; stop here if nothing changed
//   4 packages     copy the npm packages the deploy uses
//   5 upload       the deploy folder + manifest
import { spawn } from 'node:child_process';
import { glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { api, CliError } from '../util.ts';
import { build, externals } from './build.ts';
import { fingerprint } from './fingerprint.ts';
import { platformPkgs, tracePackages } from './packages.ts';
import { upload } from './upload.ts';

export type Unit = { kind: 'agent' | 'workflow' | 'step'; id: string; file: string; exportName: string; fingerprint?: string };

const INDEX_TIMEOUT_MS = 20_000;
const INDEX_CHILD = new URL('./index-child.ts', import.meta.url);

export async function indexUnits(repoDir: string): Promise<Unit[]> {
  const files: string[] = [];
  for await (const f of glob('src/mastra/**/*.{ts,tsx,mts,js,mjs}', { cwd: repoDir })) {
    if (/\.(test|spec)\.|\.d\.ts$/.test(f) || f.split('/').includes('_generated')) continue;
    files.push(f);
  }
  files.sort();
  if (!files.length) throw new CliError('no files under src/mastra/');

  const outdir = join(repoDir, '.platform/index');
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  // quick esbuild pass: npm packages external, workspace links bundled (as in the real build);
  // splitting keeps one instance per module across files
  const { metafile } = await esbuild.build({
    absWorkingDir: repoDir,
    entryPoints: files,
    outbase: 'src/mastra',
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    plugins: [externals(new Set(), { absolute: true })],
    outExtension: { '.js': '.mjs' },
    chunkNames: '_chunks/[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
  }).catch((err) => {
    throw new CliError(`index: ${err.message}`);
  });

  const entries = Object.entries(metafile.outputs)
    .filter(([, o]) => o.entryPoint)
    .map(([out, o]) => ({ src: o.entryPoint!, out: join(repoDir, out) }));
  await writeFile(join(outdir, '__files.json'), JSON.stringify(entries));

  const result = await runChild(repoDir, outdir);
  if (result.errors.length) throw new CliError(`index failed:\n  ${result.errors.join('\n  ')}`);
  return result.units;
}

function runChild(repoDir: string, outdir: string): Promise<{ units: Unit[]; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const out = join(outdir, '__units.json');
    const child = spawn(process.execPath, [fileURLToPath(INDEX_CHILD), join(outdir, '__files.json'), out, repoDir], {
      cwd: repoDir,
      // stub env: module top level must not depend on real secrets or do I/O
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', MASTRA_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliError(`index: importing src/mastra took over ${INDEX_TIMEOUT_MS / 1000}s; module top level must not do I/O`));
    }, INDEX_TIMEOUT_MS);
    child.on('exit', async (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new CliError(`index: importing src/mastra failed (exit ${code})\n${stderr}`));
      try {
        resolve(JSON.parse(await readFile(out, 'utf8')));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function table(rows: string[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => '  ' + r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i] + 2) : c)).join('').trimEnd()).join('\n');
}

export async function deploy(repoDir: string, { url, repo }: { url: string; repo: string }) {
  const known = api<Record<string, string>>(url, `/_platform/repos/${encodeURIComponent(repo)}/fingerprints`);
  known.catch(() => {}); // awaited below; don't let an early failure go unhandled meanwhile
  const units = await indexUnits(repoDir); //                                      1 index
  if (!units.length) throw new CliError('no agents, workflows or steps exported under src/mastra/');
  const built = await build(repoDir, units); //                                     2 build
  const platform = await platformPkgs(repoDir);
  await fingerprint(repoDir, units, built, platform); //                           3 fingerprint
  const prod = await known;
  if (units.every((u) => prod[u.id] === u.fingerprint)) return console.log('nothing changed');
  await tracePackages(repoDir, built, platform); //                                4 packages

  const manifest = {
    repo,
    core: platform['@mastra/core'].version,
    units: units.map((u) => ({ kind: u.kind, id: u.id, file: `units/${u.id}.mjs`, fingerprint: u.fingerprint })),
  };
  await writeFile(join(built.outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const result = await upload(url, repo, built.outdir); //                          5 upload

  const rows = result.units.map((u: any) => [u.id, u.status, u.status === 'changed' ? `v${u.from} → v${u.version}` : `v${u.version}`]);
  console.log(table(rows));
  console.log(`  uploaded as ${repo} #${result.number}`);
}
