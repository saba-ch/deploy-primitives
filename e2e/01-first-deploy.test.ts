import { expect, test } from 'vitest';
import { cli, copyExample, ROOT, run, startPlatform, streamText } from './helpers.ts';

test('first deploy of support-team: 3 units at v1 (agent, workflow, step), each in its own thread', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');

  const out = await cli(repo, 'deploy');
  expect(out).toMatch(/supportAgent\s+new\s+v1/);
  expect(out).toMatch(/escalateWorkflow\s+new\s+v1/);
  expect(out).toMatch(/classifyTicket\s+new\s+v1/);
  expect(out).toMatch(/uploaded as support-team #1/);

  // the agent streams through client-js, its tool (which uses sharp) runs inside the thread
  const reply = await streamText(platform.client, 'supportAgent', 'where is order A-1?');
  expect(reply.text).toBe('supportAgent: where is order A-1? → Order A-1 shipped');

  // the workflow answers and suspends for approval
  const run1 = await platform.client.getWorkflow('escalateWorkflow').createRun();
  const started = await run1.startAsync({ inputData: { ticketId: 'T-1', reason: 'refund over limit' } });
  expect(started.status).toBe('suspended');

  const threads = await platform.threads();
  expect(threads.map((t) => t.key).sort()).toEqual(['classifyTicket@1', 'escalateWorkflow@1', 'supportAgent@1']);
  expect(new Set(threads.map((t) => t.threadId)).size).toBe(3);

  // Mastra's own CLI works against the platform unchanged
  const api = await run(`${ROOT}/node_modules/.bin/mastra`, ['api', '--url', platform.url, 'agent', 'run', 'supportAgent', '{"messages":"hello"}']);
  expect(api.code).toBe(0);
  expect(JSON.parse(api.stdout).data.text).toBe('supportAgent: hello');

  // GET /api/agents answers from the registry, in Mastra's shape
  const agents = await platform.client.listAgents();
  expect(agents.supportAgent).toMatchObject({ id: 'supportAgent', platform: { repo: 'support-team', version: 1 } });
});
