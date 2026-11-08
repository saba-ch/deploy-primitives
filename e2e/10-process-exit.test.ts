import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, streamText } from './helpers.ts';

test('a tool that calls process.exit() ends only its thread; the next call starts it again', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace("execute: async ({ orderId }) => {", "execute: async ({ orderId }) => {\n    if (orderId === 'exit') process.exit(3);"));
  await cli(repo, 'deploy');
  const agentBefore = await platform.thread('supportAgent@1');
  const workflowBefore = await platform.thread('escalateWorkflow@1');

  const res = await fetch(`${platform.url}/api/agents/supportAgent/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: 'where is order exit?' }),
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/supportAgent@1 thread exited \(exit 3\)/);

  expect((await platform.health()).ok).toBe(true);
  expect(await platform.thread('supportAgent@1')).toBeUndefined();
  expect((await platform.thread('escalateWorkflow@1')).threadId).toBe(workflowBefore.threadId);

  const reply = await streamText(platform.client, 'supportAgent', 'where is order A-1?');
  expect(reply.text).toBe('supportAgent: where is order A-1? → Order A-1 shipped');
  expect((await platform.thread('supportAgent@1')).threadId).not.toBe(agentBefore.threadId);
});
