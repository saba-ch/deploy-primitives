// Plain code calling another team's workflow through the typed api. If escalateWorkflow's input
// schema changes and this repo pulls again, `tsc` fails here.
import { api } from './mastra/_generated/api';

export async function escalateLargeRefund(ticketId: string) {
  const run = await api.workflows.escalateWorkflow.start({ ticketId, reason: 'refund over limit' });
  return run.status === 'suspended' ? `waiting for approval (${run.runId})` : run.result?.assignee;
}
