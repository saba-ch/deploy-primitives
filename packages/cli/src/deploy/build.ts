// 2. Build: one esbuild call, one independent output file per unit (no splitting, so shared
// helpers are copied into each unit that uses them and a unit's file is all of its own code).
// npm packages stay imports; workspace packages (links outside node_modules) are bundled.
import { isBuiltin } from 'node:module';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { CliError, PLATFORM_PKGS, pkgName } from '../util.ts';
import type { Unit } from './index.ts';

export type Built = {
  outdir: string;
  metafile: esbuild.Metafile;
  /** unit id → absolute path of its built file */
  files: Record<string, string>;
  /** resolved entry file of every external npm import, so the trace can follow imports that came from bundled workspace packages */
  externalEntries: Set<string>;
};

const unitEntries = (repoDir: string, units: Unit[]): esbuild.Plugin => ({
  name: 'unit-entries',
  setup(b) {
    const byId = new Map(units.map((u) => [u.id, u]));
    b.onResolve({ filter: /^unit:/ }, (a) => ({ path: a.path.slice('unit:'.length), namespace: 'unit' }));
    b.onLoad({ filter: /.*/, namespace: 'unit' }, (a) => {
      const u = byId.get(a.path)!;
      const from = JSON.stringify('./' + u.file);
      // unit:supportAgent → export { supportAgent as default } from './src/mastra/agents/support.ts'
      // A step ships as a one-step workflow with the step's id and schemas, so the platform only
      // ever serves agents and workflows, and a step gets workflow routes, runs, suspend and resume.
      const contents =
        u.kind === 'step'
          ? `import { createWorkflow } from '@mastra/core/workflows';
import { ${u.exportName} as step } from ${from};
export default createWorkflow({ id: step.id, description: step.description, inputSchema: step.inputSchema, outputSchema: step.outputSchema }).then(step).commit();`
          : `export { ${u.exportName} as default } from ${from};`;
      return { contents, resolveDir: repoDir, loader: 'js' };
    });
  },
});

/**
 * npm packages stay external, workspace links are bundled. `absolute` (the index pass only, never
 * shipped) imports non-platform packages by their resolved path, because a package imported by a
 * bundled workspace link isn't necessarily resolvable from the repo itself (pnpm keeps it private).
 */
export const externals = (entries: Set<string>, { absolute = false } = {}): esbuild.Plugin => ({
  name: 'externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (a) => {
      if (a.pluginData?.externalsProbe) return undefined;
      if (isBuiltin(a.path)) return { path: a.path, external: true };
      const name = pkgName(a.path);
      if (!name) return undefined;
      const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: { externalsProbe: true } });
      if (r.errors.length) return { errors: r.errors };
      const real = await realpath(r.path).catch(() => r.path);
      if (!real.split('/').includes('node_modules')) return { path: r.path }; // workspace link: bundle it
      if (PLATFORM_PKGS.has(name)) return { path: a.path, external: true };
      entries.add(real);
      return { path: absolute ? real : a.path, external: true };
    });
  },
});

export async function build(repoDir: string, units: Unit[]): Promise<Built> {
  const outdir = join(repoDir, '.platform/build');
  await rm(outdir, { recursive: true, force: true });
  const externalEntries = new Set<string>();
  const result = await esbuild
    .build({
      absWorkingDir: repoDir,
      entryPoints: units.map((u) => ({ in: `unit:${u.id}`, out: u.id })),
      plugins: [unitEntries(repoDir, units), externals(externalEntries)],
      bundle: true,
      splitting: false,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outdir: join(outdir, 'units'),
      outExtension: { '.js': '.mjs' },
      // bundled CommonJS from workspace packages may still call require() for builtins
      banner: { js: "import { createRequire as __platformRequire } from 'node:module'; const require = __platformRequire(import.meta.url);" },
      metafile: true,
      logLevel: 'silent',
    })
    .catch((err) => {
      throw new CliError(`build: ${err.message}`);
    });
  const files = Object.fromEntries(units.map((u) => [u.id, join(outdir, 'units', `${u.id}.mjs`)]));
  return { outdir, metafile: result.metafile, files, externalEntries };
}
