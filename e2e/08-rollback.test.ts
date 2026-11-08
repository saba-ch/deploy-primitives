import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, streamText, waitFor } from './helpers.ts';

test('mastra-platform rollback supportAgent v1: the next call starts v1 and is served by it', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');
  await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace('Order', 'Order #'));
  await cli(repo, 'deploy');
  await waitFor(platform.threads, (ts) => !ts.some((t) => t.key === 'supportAgent@1'));

  const out = await cli(repo, 'rollback', 'supportAgent', 'v1');
  expect(out).toMatch(/supportAgent\s+prod\s+v2 → v1/);
  expect(await platform.unit('supportAgent')).toMatchObject({ prod: { version: 1 } });

  const reply = await streamText(platform.client, 'supportAgent', 'where is order A-1?');
  expect(reply.headers.get('x-platform-unit')).toBe('supportAgent@v1');
  expect(reply.text).toBe('supportAgent: where is order A-1? → Order A-1 shipped');
  expect((await platform.thread('supportAgent@1'))?.state).toBe('serving');
  await waitFor(platform.threads, (ts) => !ts.some((t) => t.key === 'supportAgent@2'));

  // explicit versions still work: supportAgent@v2 is addressable without moving prod
  const pinned = await streamText(platform.client, 'supportAgent@v2', 'where is order A-1?');
  expect(pinned.text).toBe('supportAgent: where is order A-1? → Order # A-1 shipped');
});
