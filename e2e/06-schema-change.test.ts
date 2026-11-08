import { expect, test } from 'vitest';
import { join } from 'node:path';
import { cli, cliResult, copyExample, edit, run, startPlatform } from './helpers.ts';

const tsc = (repo: string) => run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', repo]);

test("changing escalateWorkflow's input schema makes tsc fail in ops-team after it pulls", async () => {
  await startPlatform();
  const support = await copyExample('support-team');
  const ops = await copyExample('ops-team');
  await cli(support, 'deploy');
  await cli(ops, 'pull');
  const ok = await tsc(ops);
  expect(ok.stdout + ok.stderr).toBe('');
  expect(ok.code).toBe(0);

  await edit(support, 'src/mastra/workflows/escalate.ts', (s) =>
    s.replace("const EscalateInput = z.object({ ticketId: z.string(), reason: z.string() });", "const EscalateInput = z.object({ ticketId: z.string(), priority: z.enum(['low', 'high']) });")
      .replace('/refund/i.test(inputData.reason)', "inputData.priority === 'high'")
      .replace('const Triaged = z.object({ ticketId: z.string(), reason: z.string(), queue: z.string() });', "const Triaged = z.object({ ticketId: z.string(), priority: z.enum(['low', 'high']), queue: z.string() });"),
  );
  expect(await cli(support, 'deploy')).toMatch(/escalateWorkflow\s+changed\s+v1 → v2/);

  // CI catches the stale file before anyone pulls
  const stale = await cliResult(ops, 'pull', '--check');
  expect(stale.code).toBe(1);
  expect(stale.stderr).toMatch(/_generated\/api\.ts is stale/);

  await cli(ops, 'pull');
  const broken = await tsc(ops);
  expect(broken.code).not.toBe(0);
  expect(broken.stdout).toMatch(/src\/escalate\.ts.*(priority|reason)/);
});
