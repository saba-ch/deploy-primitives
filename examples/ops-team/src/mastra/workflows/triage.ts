// A workflow built from another team's published pieces: support-team's classifyTicket step and
// its supportAgent. Deploying this publishes triageWorkflow; the pieces run where they're deployed.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { api } from '../_generated/api';

export const triageWorkflow = createWorkflow({
  id: 'triageWorkflow',
  inputSchema: z.object({ ticketId: z.string(), text: z.string() }),
  outputSchema: z.object({ ticketId: z.string(), queue: z.string(), priority: z.string(), reply: z.string() }),
})
  .then(api.steps.classifyTicket)
  .map(async ({ inputData }) => ({ prompt: `Draft a short reply to this ${inputData.queue} ticket: ${inputData.text}` }))
  .then(createStep(api.agents.supportAgent))
  .map(async ({ inputData, getStepResult }) => {
    const ticket = getStepResult(api.steps.classifyTicket);
    return { ticketId: ticket.ticketId, queue: ticket.queue, priority: ticket.priority, reply: inputData.text };
  })
  .commit();
