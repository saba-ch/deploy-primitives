// Plain server code (a route handler, a queue consumer, a cron job) calling units on the platform
// through the typed api: an agent and a workflow, each where it's deployed.
import { api } from './mastra/_generated/api';

export async function handleTicket(ticketId: string, text: string, { urgent = false } = {}) {
  if (urgent) {
    const run = await api.workflows.escalateWorkflow.start({ ticketId, reason: text });
    return { escalated: run.runId };
  }
  const answer = await api.agents.supportAgent.generate(text);
  return { reply: answer.text as string };
}
