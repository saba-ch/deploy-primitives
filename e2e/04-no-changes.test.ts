import { expect, test } from 'vitest';
import { cli, copyExample, startPlatform } from './helpers.ts';

test('deploying with no changes prints "nothing changed" and uploads nothing', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');

  const out = await cli(repo, 'deploy');
  expect(out.trim()).toBe('nothing changed');
  expect(await platform.deploys()).toHaveLength(1);
});
