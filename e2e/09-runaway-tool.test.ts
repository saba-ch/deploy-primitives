import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, streamText } from './helpers.ts';

test('a tool that loops forever: the call times out, its thread is ended, other units keep answering', async () => {
  const platform = await startPlatform({ env: { PLATFORM_CALL_TIMEOUT_MS: '3000' } });
  const repo = await copyExample('support-team');
  await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace("execute: async ({ orderId }) => {", "execute: async ({ orderId }) => {\n    if (orderId === 'loop') for (;;) {}"));
  await cli(repo, 'deploy');
  const before = await platform.thread('supportAgent@1');

  const t0 = Date.now();
  const looping = fetch(`${platform.url}/api/agents/supportAgent/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: 'where is order loop?' }),
  });

  // while supportAgent's thread spins, the platform and escalateWorkflow still answer
  await new Promise((r) => setTimeout(r, 500));
  expect((await platform.health()).ok).toBe(true);
  const run = await platform.client.getWorkflow('escalateWorkflow').createRun();
  expect((await run.startAsync({ inputData: { ticketId: 'T-1', reason: 'refund' } })).status).toBe('suspended');

  const res = await looping;
  expect(res.status).toBe(504);
  expect((await res.json()).error).toMatch(/timed out after 3000ms/);
  expect(Date.now() - t0).toBeLessThan(6000);
  expect(await platform.thread('supportAgent@1')).toBeUndefined();

  // the next call starts a fresh thread
  const reply = await streamText(platform.client, 'supportAgent', 'where is order A-1?');
  expect(reply.text).toBe('supportAgent: where is order A-1? → Order A-1 shipped');
  expect((await platform.thread('supportAgent@1')).threadId).not.toBe(before.threadId);
});
