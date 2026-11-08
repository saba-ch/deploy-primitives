import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, streamText, waitFor } from './helpers.ts';

test('editing one tool only redeploys that unit', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');
  const escalateBefore = await platform.thread('escalateWorkflow@1');

  await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace('Order', 'Order #'));
  const out = await cli(repo, 'deploy');

  expect(out).toMatch(/supportAgent\s+changed\s+v1 → v2/);
  expect(out).toMatch(/escalateWorkflow\s+unchanged\s+v1/);
  expect(await platform.unit('escalateWorkflow')).toMatchObject({ prod: { version: 1 } });
  expect(await platform.unit('supportAgent')).toMatchObject({ prod: { version: 2 } });

  // v2 has a new thread and serves the new code; v1's thread drains away
  const reply = await streamText(platform.client, 'supportAgent', 'where is order A-1?');
  expect(reply.text).toBe('supportAgent: where is order A-1? → Order # A-1 shipped');
  expect(reply.headers.get('x-platform-unit')).toBe('supportAgent@v2');
  await waitFor(platform.threads, (ts) => !ts.some((t) => t.key === 'supportAgent@1'));

  // escalateWorkflow is still on its existing thread
  const escalateAfter = await platform.thread('escalateWorkflow@1');
  expect(escalateAfter.threadId).toBe(escalateBefore.threadId);
});
