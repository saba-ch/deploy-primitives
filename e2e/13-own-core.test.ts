import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cli, cliResult, copyExample, edit, startPlatform, write } from './helpers.ts';

async function pkg(dir: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) await write(dir, name, body);
}

test('a package that ships its own @mastra/core fails the build with the guard message', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  // agent-kit re-exports Agent but carries a nested copy of @mastra/core
  await pkg(join(repo, 'node_modules/agent-kit'), {
    'package.json': JSON.stringify({ name: 'agent-kit', version: '1.0.0', type: 'module', exports: './index.js', dependencies: { '@mastra/core': '1.82.0' } }),
    'index.js': "export { Agent } from '@mastra/core/agent';\n",
    'node_modules/@mastra/core/package.json': JSON.stringify({ name: '@mastra/core', version: '1.82.0', type: 'module', exports: { './agent': './agent.js' } }),
    'node_modules/@mastra/core/agent.js': 'export class Agent {}\n',
  });
  await edit(repo, 'src/mastra/agents/support.ts', (s) => s.replace("from '@mastra/core/agent'", "from 'agent-kit'"));

  const r = await cliResult(repo, 'deploy');
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/@mastra\/core must come from the platform, but the deploy carries its own copy \(.*agent-kit\/node_modules\/@mastra\/core\)/);
  expect(await platform.deploys()).toHaveLength(0);
});

test('a package that inlines its own Agent class fails the build with the guard message', async () => {
  await startPlatform();
  const repo = await copyExample('support-team');
  await pkg(join(repo, 'node_modules/bundled-kit'), {
    'package.json': JSON.stringify({ name: 'bundled-kit', version: '1.0.0', type: 'module', exports: './index.js' }),
    // what a package looks like when its build inlined @mastra/core's Agent
    'index.js': 'export class Agent { constructor(o) { Object.assign(this, o); } stream() {} generate() {} getModel() {} }\n',
  });
  await edit(repo, 'src/mastra/agents/support.ts', (s) => s.replace("from '@mastra/core/agent'", "from 'bundled-kit'"));

  const r = await cliResult(repo, 'deploy');
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/supportAgent looks like a agent but was built against its own copy of @mastra\/core; it must come from the platform/);
});

test('the platform refuses a unit file whose Agent is not the platform\'s (second line of defence)', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');
  // hand-craft a deploy whose unit default-exports a foreign Agent-shaped object
  const dir = join(repo, '.platform/forged');
  await pkg(dir, {
    'manifest.json': JSON.stringify({ repo: 'support-team', core: '1.82.0', units: [{ kind: 'agent', id: 'supportAgent', file: 'units/supportAgent.mjs', fingerprint: 'forged' }] }),
    'units/supportAgent.mjs': "class Agent { id = 'supportAgent'; stream() {} getModel() {} }\nexport default new Agent();\n",
  });
  const tgz = join(repo, '.platform/forged.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
  const res = await fetch(`${platform.url}/_platform/deploys/support-team`, { method: 'PUT', body: await readFile(tgz) });
  expect(res.status).toBe(422);
  expect((await res.json()).error).toMatch(/unit bundles its own @mastra\/core/);
  // nothing moved: v1 is still prod and still answers
  expect(await platform.unit('supportAgent')).toMatchObject({ prod: { version: 1 } });
});
