import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cli, copyExample, startPlatform } from './helpers.ts';

test('an exported step is a unit: pulled as api.steps, composed into another repo’s workflow', async () => {
  const platform = await startPlatform();
  const support = await copyExample('support-team');
  const ops = await copyExample('ops-team');

  expect(await cli(support, 'deploy')).toMatch(/classifyTicket\s+new\s+v1/);

  // served as a one-step workflow, so it has Mastra's workflow routes (that's how other repos run it)
  const workflows = await platform.client.listWorkflows();
  expect(workflows.classifyTicket).toMatchObject({ platform: { repo: 'support-team', version: 1, kind: 'step' } });
  const direct = await platform.client.getWorkflow('classifyTicket').createRun();
  const classified = await direct.startAsync({ inputData: { ticketId: 'T-1', text: 'Where is my order?' } });
  expect(classified.status === 'success' && classified.result).toEqual({ ticketId: 'T-1', text: 'Where is my order?', queue: 'shipping', priority: 'low' });

  // another repo gets it, typed, under api.steps
  expect(await cli(ops, 'pull')).toMatch(/1 agents, 1 workflows, 1 steps/);
  const out = await cli(ops, 'deploy');
  expect(out).toMatch(/triageWorkflow\s+new\s+v1/);

  // triageWorkflow = support-team's step → support-team's agent, each running where it's deployed
  const triage = await platform.client.getWorkflow('triageWorkflow').createRun();
  const result = await triage.startAsync({ inputData: { ticketId: 'T-7', text: 'I was charged twice, please refund asap' } });
  expect(result.status).toBe('success');
  expect(result.status === 'success' && result.result).toEqual({
    ticketId: 'T-7',
    queue: 'billing',
    priority: 'high',
    reply: 'supportAgent: Draft a short reply to this billing ticket: I was charged twice, please refund asap',
  });
  const keys = (await platform.threads()).map((t) => t.key);
  expect(keys).toEqual(expect.arrayContaining(['classifyTicket@1', 'supportAgent@1', 'triageWorkflow@1']));

  // in the generated api a step is only a step: no start/resume of its own
  const generated = await readFile(join(ops, 'src/mastra/_generated/api.ts'), 'utf8');
  expect(generated).toMatch(/classifyTicket: remoteStep\(/);

  // plain server code calls the agent and a workflow through the typed api
  const { handleTicket } = await import(join(ops, 'src/inbox.ts'));
  expect(await handleTicket('T-8', 'Where is my parcel?')).toEqual({ reply: 'supportAgent: Where is my parcel?' });
  expect(await handleTicket('T-9', 'Refund me', { urgent: true })).toEqual({ escalated: expect.any(String) });
});
