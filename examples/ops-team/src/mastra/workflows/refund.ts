// A workflow built on another team's agent: support-team's supportAgent, as a step.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { api } from '../_generated/api';

export const refundWorkflow = createWorkflow({
  id: 'refundWorkflow',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ text: z.string() }),
})
  .then(createStep(api.agents.supportAgent)) // deployed from support-team
  .commit();
