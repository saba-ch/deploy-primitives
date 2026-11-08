// written by `mastra-platform pull`, do not edit
import { remoteAgent, remoteStep, remoteWorkflow } from '@mastra/platform-client';
import { z } from 'zod';

// classifyTicket (step from support-team)
export const ClassifyTicketInput = z.object({ "ticketId": z.string(), "text": z.string() }).strict();
export type ClassifyTicketInput = z.infer<typeof ClassifyTicketInput>;
export const ClassifyTicketOutput = z.object({ "ticketId": z.string(), "text": z.string(), "queue": z.enum(["billing","shipping","support"]), "priority": z.enum(["low","high"]) }).strict();
export type ClassifyTicketOutput = z.infer<typeof ClassifyTicketOutput>;

// escalateWorkflow (workflow from support-team)
export const EscalateWorkflowInput = z.object({ "ticketId": z.string(), "reason": z.string() }).strict();
export type EscalateWorkflowInput = z.infer<typeof EscalateWorkflowInput>;
export const EscalateWorkflowOutput = z.object({ "assignee": z.string(), "note": z.string() }).strict();
export type EscalateWorkflowOutput = z.infer<typeof EscalateWorkflowOutput>;

export const api = {
  agents: {
    supportAgent: remoteAgent({ id: "supportAgent", ref: 'prod' }),
  },
  workflows: {
    escalateWorkflow: remoteWorkflow({ id: "escalateWorkflow", ref: 'prod', input: EscalateWorkflowInput, output: EscalateWorkflowOutput }),
  },
  steps: {
    classifyTicket: remoteStep({ id: "classifyTicket", ref: 'prod', input: ClassifyTicketInput, output: ClassifyTicketOutput }),
  },
} as const;
