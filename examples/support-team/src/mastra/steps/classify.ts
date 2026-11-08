// A published step: exporting it deploys it on its own, and other repos use it as
// `api.steps.classifyTicket`, in their workflows or from plain code.
import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

export const Ticket = z.object({ ticketId: z.string(), text: z.string() });

export const classifyTicket = createStep({
  id: 'classifyTicket',
  description: 'Sort a support ticket into a queue and a priority',
  inputSchema: Ticket,
  outputSchema: Ticket.extend({
    queue: z.enum(['billing', 'shipping', 'support']),
    priority: z.enum(['low', 'high']),
  }),
  execute: async ({ inputData }) => {
    const { text } = inputData;
    const queue = /refund|charge|invoice|paid/i.test(text) ? 'billing' : /order|ship|deliver|track/i.test(text) ? 'shipping' : 'support';
    const priority = /urgent|asap|immediately|!/i.test(text) ? 'high' : 'low';
    return { ...inputData, queue, priority } as const;
  },
});
