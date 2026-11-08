import { expect, test } from 'vitest';
import { cli, copyExample, startPlatform, write } from './helpers.ts';

test("an ops-team tool reading process.env sees only ops-team's secrets", async () => {
  const platform = await startPlatform();
  const support = await copyExample('support-team');
  const ops = await copyExample('ops-team');
  await cli(support, 'secrets', 'set', 'ZENDESK_TOKEN=zd-secret-123');
  await cli(support, 'deploy');

  await write(ops, 'src/mastra/workflows/env.ts', `
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const readEnv = createTool({
  id: 'readEnv',
  description: 'Reads process.env',
  inputSchema: z.object({}),
  outputSchema: z.object({ env: z.record(z.string(), z.string()) }),
  execute: async () => ({ env: { ...process.env } as Record<string, string> }),
});

export const envWorkflow = createWorkflow({ id: 'envWorkflow', inputSchema: z.object({}), outputSchema: z.object({ env: z.record(z.string(), z.string()) }) })
  .then(createStep(readEnv))
  .commit();
`);
  expect(await cli(ops, 'secrets', 'set', 'OPS_TOKEN=ops-secret-456')).toMatch(/ops-team secrets: OPS_TOKEN/);
  await cli(ops, 'pull');
  await cli(ops, 'deploy');

  const run = await platform.client.getWorkflow('envWorkflow').createRun();
  const r = await run.startAsync({ inputData: {} });
  expect(r.status).toBe('success');
  const env = (r.status === 'success' ? r.result.env : {}) as Record<string, string>;
  expect(Object.keys(env).sort()).toEqual(['MASTRA_PLATFORM_URL', 'MASTRA_TELEMETRY_DISABLED', 'OPS_TOKEN']);
  expect(env.OPS_TOKEN).toBe('ops-secret-456');
  expect(JSON.stringify(env)).not.toContain('zd-secret-123');

  // secrets list shows keys, never values
  expect(await cli(support, 'secrets', 'list')).toBe('  ZENDESK_TOKEN\n');
});
