// written by `mastra-platform pull --target web`, do not edit
import { MastraClient } from '@mastra/client-js';
import { typedAgent, typedWorkflow } from '@mastra/platform-client/web';
import { z } from 'zod';

// escalateWorkflow (workflow from support-team)
export const EscalateWorkflowInput = z.object({ "ticketId": z.string(), "reason": z.string() }).strict();
export type EscalateWorkflowInput = z.infer<typeof EscalateWorkflowInput>;
export const EscalateWorkflowOutput = z.object({ "assignee": z.string(), "note": z.string() }).strict();
export type EscalateWorkflowOutput = z.infer<typeof EscalateWorkflowOutput>;

// refundWorkflow (workflow from ops-team)
export const RefundWorkflowInput = z.object({ "prompt": z.string() }).strict();
export type RefundWorkflowInput = z.infer<typeof RefundWorkflowInput>;
export const RefundWorkflowOutput = z.object({ "text": z.string() }).strict();
export type RefundWorkflowOutput = z.infer<typeof RefundWorkflowOutput>;

// triageWorkflow (workflow from ops-team)
export const TriageWorkflowInput = z.object({ "ticketId": z.string(), "text": z.string() }).strict();
export type TriageWorkflowInput = z.infer<typeof TriageWorkflowInput>;
export const TriageWorkflowOutput = z.object({ "ticketId": z.string(), "queue": z.string(), "priority": z.string(), "reply": z.string() }).strict();
export type TriageWorkflowOutput = z.infer<typeof TriageWorkflowOutput>;

export const baseUrl = "http://localhost:4200";
export const client = new MastraClient({ baseUrl });

export const api = {
  agents: {
    supportAgent: typedAgent(client, "supportAgent"),
  },
  workflows: {
    escalateWorkflow: typedWorkflow<EscalateWorkflowInput, EscalateWorkflowOutput>(client, "escalateWorkflow"),
    refundWorkflow: typedWorkflow<RefundWorkflowInput, RefundWorkflowOutput>(client, "refundWorkflow"),
    triageWorkflow: typedWorkflow<TriageWorkflowInput, TriageWorkflowOutput>(client, "triageWorkflow"),
  },
};
