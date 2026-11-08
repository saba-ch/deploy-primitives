import { expect, test } from 'vitest';
import { cli, copyExample, edit, startPlatform, waitFor } from './helpers.ts';

test('a suspended run resumes on the version it started on, new runs land on the new one', async () => {
  const platform = await startPlatform();
  const repo = await copyExample('support-team');
  await cli(repo, 'deploy');
  const wf = platform.client.getWorkflow('escalateWorkflow');

  const old = await wf.createRun();
  expect((await old.startAsync({ inputData: { ticketId: 'T-1', reason: 'refund over limit' } })).status).toBe('suspended');

  await edit(repo, 'src/mastra/workflows/escalate.ts', (s) => s.replace('assigned to', 'handed to'));
  expect(await cli(repo, 'deploy')).toMatch(/escalateWorkflow\s+changed\s+v1 → v2/);

  // the suspended run holds no thread: v1's thread drains away after the swap
  await waitFor(platform.threads, (ts) => !ts.some((t) => t.key === 'escalateWorkflow@1'));

  // resuming starts v1's thread again from its deploy folder and runs v1's code
  const res = await fetch(`${platform.url}/api/workflows/escalateWorkflow/resume-async?runId=${old.runId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 'approve', resumeData: { approved: true, assignee: 'sam' } }),
  });
  expect(res.headers.get('x-platform-unit')).toBe('escalateWorkflow@v1');
  const resumed = await res.json();
  expect(resumed.status).toBe('success');
  expect(resumed.result.note).toBe('Ticket T-1 (billing) assigned to sam');

  // a new run is created on v2 and stays there
  const fresh = await wf.createRun();
  await fresh.startAsync({ inputData: { ticketId: 'T-2', reason: 'refund over limit' } });
  const done = await fresh.resumeAsync({ step: 'approve', resumeData: { approved: true, assignee: 'kim' } });
  expect(done.status === 'success' && done.result.note).toBe('Ticket T-2 (billing) handed to kim');

  const runs = await platform.get('/_platform/runs');
  expect(runs.find((r: any) => r.run_id === old.runId)).toMatchObject({ version: 1, status: 'success' });
  expect(runs.find((r: any) => r.run_id === fresh.runId)).toMatchObject({ version: 2, status: 'success' });
});
