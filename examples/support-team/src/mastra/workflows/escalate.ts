import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { formatLine } from '../lib/format';

const EscalateInput = z.object({ ticketId: z.string(), reason: z.string() });
const Triaged = z.object({ ticketId: z.string(), reason: z.string(), queue: z.string() });
const EscalateOutput = z.object({ assignee: z.string(), note: z.string() });

const triage = createStep({
  id: 'triage',
  inputSchema: EscalateInput,
  outputSchema: Triaged,
  execute: async ({ inputData }) => ({ ...inputData, queue: /refund/i.test(inputData.reason) ? 'billing' : 'support' }),
});

// Suspends until someone approves; resume with { approved, assignee }.
const approve = createStep({
  id: 'approve',
  inputSchema: Triaged,
  outputSchema: EscalateOutput,
  suspendSchema: z.object({ ticketId: z.string(), queue: z.string() }),
  resumeSchema: z.object({ approved: z.boolean(), assignee: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend({ ticketId: inputData.ticketId, queue: inputData.queue });
    const assignee = resumeData.approved ? resumeData.assignee : 'nobody';
    return { assignee, note: formatLine(`Ticket ${inputData.ticketId} (${inputData.queue}) assigned to ${assignee}`) };
  },
});

export const escalateWorkflow = createWorkflow({
  id: 'escalateWorkflow',
  inputSchema: EscalateInput,
  outputSchema: EscalateOutput,
})
  .then(triage)
  .then(approve)
  .commit();
