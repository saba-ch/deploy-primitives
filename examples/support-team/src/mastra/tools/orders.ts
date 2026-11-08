import { createTool } from '@mastra/core/tools';
import sharp from 'sharp';
import { z } from 'zod';
import { formatLine } from '../lib/format';

const shipped = (orderId: string) => formatLine(`Order ${orderId} shipped`);

export const lookupOrder = createTool({
  id: 'lookupOrder',
  description: 'Look up an order by id',
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({ orderId: z.string(), status: z.string(), summary: z.string(), receiptBytes: z.number() }),
  execute: async ({ orderId }) => {
    // a native package, to prove those load inside a unit thread
    const receipt = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a7' } }).png().toBuffer();
    return { orderId, status: 'shipped', summary: shipped(orderId), receiptBytes: receipt.length };
  },
});

export const issueRefund = createTool({
  id: 'issueRefund',
  description: 'Refund an order',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  outputSchema: z.object({ refundId: z.string() }),
  execute: async ({ orderId, amount }) => ({ refundId: `rf_${orderId}_${Math.round(amount * 100)}` }),
});
