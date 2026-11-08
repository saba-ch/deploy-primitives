import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { model } from '../model';
import { issueRefund, lookupOrder } from '../tools/orders';

export const supportAgent = new Agent({
  id: 'supportAgent',
  name: 'supportAgent',
  instructions: 'You help customers with orders and refunds. Look an order up with lookupOrder before answering about it. Keep answers short.',
  model: model('supportAgent'),
  tools: { lookupOrder, issueRefund },
  memory: new Memory(), // threads live in the platform's shared storage
});
