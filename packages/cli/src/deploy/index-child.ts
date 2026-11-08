// The index pass, run in a child process with stub env vars: imports every prebuilt file and reports
// the exports that are agents, workflows or steps. The platform packages resolve to the repo's root
// copy, the same way they resolve to the platform's copy in a unit thread.
//   node index-child.ts <files.json> <units.json> <repoDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolvePlatformPkgsFrom } from '@mastra/platform/platform-pkgs';

const [, , input, output, root] = process.argv;
enableCompileCache();
resolvePlatformPkgsFrom(pathToFileURL(`${root}/package.json`).href);

// the repo's @mastra/core (the CLI has none of its own), so these are untyped
const repoImport = (spec: string): Promise<any> => import(spec);
const [{ Agent }, { Workflow }, { Tool }] = await Promise.all(['agent', 'workflows', 'tools'].map((p) => repoImport(`@mastra/core/${p}`)));
/** Marks a reference to another repo's unit; same key as @mastra/platform-client's REMOTE. */
const REMOTE = Symbol.for('mastra.platform.remote');

// createStep returns a plain object; a tool has the same shape but is a Tool instance
const isStep = (v: any) => typeof v.id === 'string' && typeof v.execute === 'function' && v.inputSchema && v.outputSchema && !(v instanceof Tool);
const looksLike = (v: any) =>
  typeof v?.id !== 'string' ? null
  : typeof v.stream === 'function' && typeof v.getModel === 'function' ? 'agent'
  : typeof v.createRun === 'function' && typeof v.commit === 'function' ? 'workflow'
  : null;

const units: { kind: string; id: string; file: string; exportName: string }[] = [];
const errors: string[] = [];
const seen = new Map<string, { value: unknown; file: string }>();
for (const f of JSON.parse(readFileSync(input, 'utf8')) as { src: string; out: string }[]) {
  let mod: Record<string, any>;
  try {
    mod = await import(pathToFileURL(f.out).href);
  } catch (err: any) {
    errors.push(`${f.src}: ${err?.message ?? err}`);
    continue;
  }
  for (const [exportName, value] of Object.entries(mod)) {
    if (!value || typeof value !== 'object' || value[REMOTE]) continue; // a reference to someone else's unit
    const kind = value instanceof Agent ? 'agent' : value instanceof Workflow ? 'workflow' : isStep(value) ? 'step' : null;
    if (!kind) {
      const k = looksLike(value);
      if (k) errors.push(`${f.src}: ${exportName} looks like a ${k} but was built against its own copy of @mastra/core; it must come from the platform`);
      continue;
    }
    const prev = seen.get(value.id);
    if (prev) {
      if (prev.value !== value) errors.push(`two units with id ${value.id}: ${prev.file} and ${f.src}`);
      continue;
    }
    seen.set(value.id, { value, file: f.src });
    units.push({ kind, id: value.id, file: f.src, exportName });
  }
}
writeFileSync(output, JSON.stringify({ units, errors }));
process.exit(0);
