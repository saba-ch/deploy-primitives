// mastra-platform pull: reads every unit on the platform with client-js itself (listAgents,
// listWorkflows; the platform answers both from its registry) and writes one typed file. Types
// come from the workflows' JSON Schemas, so a repo needs nothing from another repo.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MastraClient } from '@mastra/client-js';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import { CliError } from './util.ts';

type Opts = { url: string; repo: string; check?: boolean; target?: string; out?: string };

const pascal = (id: string) => id.replace(/(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase());
const key = (id: string) => (/^[A-Za-z_$][\w$]*$/.test(id) ? id : JSON.stringify(id));

/** Mastra serializes schemas as superjson strings: '{"json": {…JSON Schema…}}'. */
function parseSchema(raw: unknown): object | undefined {
  if (!raw) return undefined;
  let v: any = raw;
  if (typeof v === 'string') v = JSON.parse(v);
  if (v && typeof v === 'object' && 'json' in v && Object.keys(v).length <= 2) v = v.json;
  if (v && typeof v === 'object') delete v.$schema;
  return v;
}

const zod = (schema: object | undefined) => (schema ? jsonSchemaToZod(schema as any, { module: 'none', zodVersion: 4 }) : 'z.unknown()');

export async function render({ url, repo, target }: Opts): Promise<{ code: string; counts: string }> {
  let agents: Record<string, any>;
  let workflows: Record<string, any>;
  try {
    const client = new MastraClient({ baseUrl: url, retries: 0 });
    [agents, workflows] = await Promise.all([client.listAgents(), client.listWorkflows()]);
  } catch (err: any) {
    throw new CliError(`can't read units from ${url}: ${err.message}`);
  }
  // A repo's own units aren't remote to it. Published steps are listed with the workflows; they're
  // for composing into workflows, so the web api (which can't compose) leaves them out.
  const remote = (u: any) => u?.platform?.repo !== repo;
  const isStep = (u: any) => u?.platform?.kind === 'step';
  const agentIds = Object.keys(agents).filter((id) => remote(agents[id])).sort();
  const remoteWorkflows = Object.keys(workflows).filter((id) => remote(workflows[id])).sort();
  const workflowIds = remoteWorkflows.filter((id) => !isStep(workflows[id]));
  const stepIds = remoteWorkflows.filter((id) => isStep(workflows[id]));

  const web = target === 'web';
  const schemas: string[] = [];
  for (const id of web ? workflowIds : remoteWorkflows) {
    const w = workflows[id];
    const owner = w.platform ? ` (${isStep(w) ? 'step' : 'workflow'} from ${w.platform.repo})` : '';
    schemas.push(`// ${id}${owner}`);
    for (const [suffix, raw] of [['Input', w.inputSchema], ['Output', w.outputSchema]] as const) {
      const name = `${pascal(id)}${suffix}`;
      schemas.push(`export const ${name} = ${zod(parseSchema(raw))};`);
      schemas.push(`export type ${name} = z.infer<typeof ${name}>;`);
    }
    schemas.push('');
  }

  const counts = `${agentIds.length} agents, ${workflowIds.length} workflows${web ? '' : `, ${stepIds.length} steps`}`;
  const group = (name: string, ids: string[], entry: (id: string) => string) => [
    `  ${name}: {`,
    ...ids.map((id) => `    ${key(id)}: ${entry(id)},`),
    '  },',
  ];

  if (web) {
    const run = (id: string) => `typedWorkflow<${pascal(id)}Input, ${pascal(id)}Output>(client, ${JSON.stringify(id)})`;
    const code = [
      '// written by `mastra-platform pull --target web`, do not edit',
      "import { MastraClient } from '@mastra/client-js';",
      "import { typedAgent, typedWorkflow } from '@mastra/platform-client/web';",
      "import { z } from 'zod';",
      '',
      ...schemas,
      `export const baseUrl = ${JSON.stringify(url)};`,
      'export const client = new MastraClient({ baseUrl });',
      '',
      'export const api = {',
      ...group('agents', agentIds, (id) => `typedAgent(client, ${JSON.stringify(id)})`),
      ...group('workflows', workflowIds, run),
      '};',
      '',
    ].join('\n');
    return { code, counts };
  }

  const remoteRef = (fn: string) => (id: string) =>
    `${fn}({ id: ${JSON.stringify(id)}, ref: 'prod', input: ${pascal(id)}Input, output: ${pascal(id)}Output })`;
  const code = [
    '// written by `mastra-platform pull`, do not edit',
    "import { remoteAgent, remoteStep, remoteWorkflow } from '@mastra/platform-client';",
    "import { z } from 'zod';",
    '',
    ...schemas,
    'export const api = {',
    ...group('agents', agentIds, (id) => `remoteAgent({ id: ${JSON.stringify(id)}, ref: 'prod' })`),
    ...group('workflows', workflowIds, remoteRef('remoteWorkflow')),
    ...group('steps', stepIds, remoteRef('remoteStep')),
    '} as const;',
    '',
  ].join('\n');
  return { code, counts };
}

export async function pull(repoDir: string, opts: Opts) {
  const file = opts.out ?? (opts.target === 'web' ? 'src/_generated/api.ts' : 'src/mastra/_generated/api.ts');
  const path = join(repoDir, file);
  const { code, counts } = await render(opts);
  if (opts.check) {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current !== code) throw new CliError(`${file} is stale; run \`mastra-platform pull${opts.target ? ` --target ${opts.target}` : ''}\``);
    console.log(`${file} is up to date`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, code);
  console.log(`wrote ${file}: ${counts}`);
}
