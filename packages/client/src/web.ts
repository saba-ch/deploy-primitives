// Browser-safe helpers for files written by `mastra-platform pull --target web`: no @mastra/core.
// The Node entry (remote-agent, remote-workflow) builds on these too.
import type { MastraClient } from '@mastra/client-js';

/** Marks references to other units, so `deploy` doesn't mistake them for this repo's own. */
export const REMOTE = Symbol.for('mastra.platform.remote');

/** The platform reads id@ref: 'prod' → 'supportAgent', 'v14' → 'supportAgent@v14'. */
export const at = (id: string, ref: string) => (ref === 'prod' ? id : `${id}@${ref}`);

/** What a workflow run ends with: its status, and the result once it succeeded. */
export type RunResult<O> = { runId: string; status: string; result?: O; suspended?: string[][]; error?: unknown; [k: string]: unknown };

type ClientAgent = ReturnType<MastraClient['getAgent']>;

/** An agent on the platform, as `pull --target web` writes it: pass it to `useChat`, or call it. */
export type TypedAgent<Id extends string = string> = {
  readonly kind: 'agent';
  readonly id: Id;
  /** What goes on the wire: 'supportAgent', or 'supportAgent@v14' when pinned. */
  readonly target: string;
  generate: ClientAgent['generate'];
  stream: ClientAgent['stream'];
};

export function typedAgent<Id extends string>(client: MastraClient, id: Id, ref = 'prod'): TypedAgent<Id> {
  const target = at(id, ref);
  const remote = client.getAgent(target);
  return { kind: 'agent', id, target, generate: remote.generate.bind(remote), stream: remote.stream.bind(remote) };
}

export type TypedRun<I, O> = {
  runId: string;
  start: (inputData: I) => Promise<RunResult<O>>;
  resume: (step: string | string[], resumeData: unknown) => Promise<RunResult<O>>;
};

/** client.getWorkflow(id) with the input and output types from the platform's schemas. */
export function typedWorkflow<I, O>(client: MastraClient, id: string, ref = 'prod') {
  const wf = client.getWorkflow(at(id, ref));
  async function createRun(runId?: string): Promise<TypedRun<I, O>> {
    const run = await wf.createRun(runId ? { runId } : undefined);
    const withId = (r: any): RunResult<O> => ({ ...r, runId: run.runId });
    return {
      runId: run.runId,
      start: async (inputData) => withId(await run.startAsync({ inputData: inputData as any })),
      resume: async (step, resumeData) => withId(await run.resumeAsync({ step, resumeData } as any)),
    };
  }
  return {
    id,
    createRun,
    start: async (inputData: I) => (await createRun()).start(inputData),
  };
}
