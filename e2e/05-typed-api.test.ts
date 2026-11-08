import { expect, test } from 'vitest';
import { cli, copyExample, startPlatform } from './helpers.ts';

test('ops-team pulls, deploys and runs refundWorkflow, which calls supportAgent in another thread', async () => {
  const platform = await startPlatform();
  const support = await copyExample('support-team');
  const ops = await copyExample('ops-team');
  await cli(support, 'deploy');

  expect(await cli(ops, 'pull')).toMatch(/wrote src\/mastra\/_generated\/api\.ts: 1 agents, 1 workflows/);
  await cli(ops, 'pull', '--check');
  const out = await cli(ops, 'deploy');
  expect(out).toMatch(/refundWorkflow\s+new\s+v1/);
  expect(out).toMatch(/uploaded as ops-team #1/);

  const callsBefore = (await platform.thread('supportAgent@1')).calls;
  const run = await platform.client.getWorkflow('refundWorkflow').createRun();
  const result = await run.startAsync({ inputData: { prompt: 'where is order A-1?' } });
  expect(result.status).toBe('success');
  expect(result.status === 'success' && result.result).toEqual({ text: 'supportAgent: where is order A-1? → Order A-1 shipped' });

  // thread → HTTP → thread: refundWorkflow's thread called supportAgent's thread through the platform
  const threads = await platform.threads();
  const refund = threads.find((t) => t.key === 'refundWorkflow@1');
  const agent = threads.find((t) => t.key === 'supportAgent@1');
  expect(refund.threadId).not.toBe(agent.threadId);
  expect(agent.calls).toBe(callsBefore + 1);

  // ops-team's own units are not in its generated api; support-team's pull now sees refundWorkflow and triageWorkflow
  expect(await cli(support, 'pull')).toMatch(/0 agents, 2 workflows, 0 steps/);
});
