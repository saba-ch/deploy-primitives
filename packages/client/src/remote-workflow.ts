// References to units deployed on the platform. remoteStep is a step that runs there, so it
// composes with .then(). remoteWorkflow is the same, plus typed start/resume for plain code.
import { createStep } from '@mastra/core/workflows';
import type { z } from 'zod';
import { client } from './remote-agent';
import { REMOTE, typedWorkflow } from './web';

type Ref<I, O> = { id: string; ref?: string; input: I; output: O };

function remote<I extends z.ZodType, O extends z.ZodType>({ id, ref = 'prod', input, output }: Ref<I, O>) {
  // per call, so a unit thread picks up MASTRA_PLATFORM_URL
  const target = () => typedWorkflow<z.input<I>, z.output<O>>(client(), id, ref);
  const start = (inputData: z.input<I>) => target().start(inputData);
  const resume = async (runId: string, step: string | string[], resumeData: unknown) => (await target().createRun(runId)).resume(step, resumeData);

  const step = createStep({
    id,
    description: `${id} on the platform (${ref})`,
    inputSchema: input,
    outputSchema: output,
    execute: async ({ inputData }) => {
      const r = await start(inputData as z.input<I>);
      if (r.status !== 'success') throw new Error(`${id} run ${r.runId} ended with status ${r.status}`);
      return r.result as any;
    },
  });
  return { step, start, resume };
}

export function remoteStep<I extends z.ZodType, O extends z.ZodType>(ref: Ref<I, O>) {
  return Object.assign(remote(ref).step, { [REMOTE]: true as const });
}

export function remoteWorkflow<I extends z.ZodType, O extends z.ZodType>(ref: Ref<I, O>) {
  const { step, start, resume } = remote(ref);
  return Object.assign(step, { [REMOTE]: true as const, start, resume });
}
