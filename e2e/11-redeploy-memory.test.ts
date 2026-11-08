import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, streamText, waitFor } from './helpers.ts';

const REDEPLOYS = Number(process.env.REDEPLOYS ?? 50);
const MB = 1e6;

test(`redeploying supportAgent ${REDEPLOYS} times: platform memory returns close to where it started`, { timeout: 900_000 }, async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace("description: 'Look up an order by id'", "description: 'Look up an order by id (rev 0)'"));
  await cli(repo, 'deploy');
  await streamText(platform.client, 'supportAgent', 'where is order A-1?');

  const rss = async () => (await platform.post('/_platform/gc')).rss as number;
  await rss();
  const baseline = await rss();
  const samples: number[] = [];

  for (let i = 1; i <= REDEPLOYS; i++) {
    await edit(repo, 'src/mastra/tools/orders.ts', (s) => s.replace(/\(rev \d+\)/, `(rev ${i})`));
    const out = await cli(repo, 'deploy');
    expect(out).toMatch(new RegExp(`supportAgent\\s+changed\\s+v${i} → v${i + 1}`));
    // a call on the new version (its tool loads sharp, a native package, from this deploy's folder)
    const reply = await streamText(platform.client, 'supportAgent', `where is order N-${i}?`);
    expect(reply.headers.get('x-platform-unit')).toBe(`supportAgent@v${i + 1}`);
    if (i % 10 === 0) samples.push(await rss());
  }

  // old threads end once drained; only the current version (and escalateWorkflow's) stay
  await waitFor(platform.threads, (ts) => ts.filter((t) => t.unit === 'supportAgent').length === 1, 30_000);
  await rss();
  const after = await rss();
  console.log(
    `platform RSS: baseline ${(baseline / MB).toFixed(0)} MB, every 10 deploys ${samples.map((s) => (s / MB).toFixed(0)).join(' → ')} MB, after drain ${(after / MB).toFixed(0)} MB`,
  );
  // "close to where it started": within 150 MB of the one-thread baseline after 50 thread lifetimes
  expect(after - baseline).toBeLessThan(150 * MB);

  // cleanup keeps the deploy folders bounded: prod, the last 5, and nothing else
  await platform.post('/_platform/cleanup');
  const folders = await readdir(join(platform.home, 'deploys'));
  expect(folders.length).toBeLessThanOrEqual(6);
  expect(folders).toContain('support-team-1'); // escalateWorkflow v1 is still prod there
});
