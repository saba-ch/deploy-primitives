import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform } from './helpers.ts';

test('editing lib/format.ts gives both units a new version', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');

  await edit(repo, 'src/mastra/lib/format.ts', (s) => s.replace('.trim()', '.trim() + ""'));
  const out = await cli(repo, 'deploy');

  expect(out).toMatch(/supportAgent\s+changed\s+v1 → v2/);
  expect(out).toMatch(/escalateWorkflow\s+changed\s+v1 → v2/);
  expect(out).toMatch(/uploaded as support-team #2/);
  expect(await platform.unit('supportAgent')).toMatchObject({ prod: { version: 2 } });
  expect(await platform.unit('escalateWorkflow')).toMatchObject({ prod: { version: 2 } });
});
