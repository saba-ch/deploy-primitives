// A real model when the repo has a key (set as a repo secret: MASTRA_GATEWAY_API_KEY for Mastra's
// model gateway, or ANTHROPIC_API_KEY), otherwise a mock that answers "<agentId>: <prompt>" and
// calls lookupOrder when the prompt mentions an order, so tests need no key and give the same
// answer every run. Resolved per call, so the thread's env decides.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

export function model(agentId: string) {
  return () => {
    if (process.env.MASTRA_GATEWAY_API_KEY) return 'mastra/openai/gpt-6-luna';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic/claude-sonnet-5-5';
    return echoModel(agentId);
  };
}

type Part = { type: string; text?: string; output?: { type: string; value: unknown } };
type Message = { role: string; content: string | Part[] };

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const textOf = (m: Message) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''));

function answer(agentId: string, prompt: Message[], tools: { name: string }[] = []) {
  const user = [...prompt].reverse().find((m) => m.role === 'user');
  const question = user ? textOf(user).trim() : '';
  const last = prompt[prompt.length - 1];
  if (last?.role === 'tool') {
    const results = (last.content as Part[]).map((p) => {
      const v = p.output?.value as any;
      return typeof v === 'string' ? v : v?.summary ?? JSON.stringify(v);
    });
    return { text: `${agentId}: ${question} → ${results.join('; ')}` };
  }
  const order = /\border\s+#?([\w-]+)/i.exec(question);
  if (order && tools.some((t) => t.name === 'lookupOrder')) {
    return { toolCall: { toolCallId: `call-${order[1]}`, toolName: 'lookupOrder', input: JSON.stringify({ orderId: order[1] }) } };
  }
  return { text: `${agentId}: ${question}` };
}

// `any`: ai's mock implements a newer patch of the v4 model spec than core's types name.
function echoModel(agentId: string): any {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'echo',
    doGenerate: async (opts: any) => {
      const a = answer(agentId, opts.prompt, opts.tools);
      return a.toolCall
        ? { content: [{ type: 'tool-call', ...a.toolCall }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }
        : { content: [{ type: 'text', text: a.text! }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    },
    doStream: async (opts: any) => {
      const a = answer(agentId, opts.prompt, opts.tools);
      const chunks: any[] = [{ type: 'stream-start', warnings: [] }];
      if (a.toolCall) {
        chunks.push({ type: 'tool-call', ...a.toolCall });
        chunks.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage });
      } else {
        chunks.push({ type: 'text-start', id: 't' });
        for (const word of a.text!.split(/(?<= )/)) chunks.push({ type: 'text-delta', id: 't', delta: word });
        chunks.push({ type: 'text-end', id: 't' });
        chunks.push({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
      }
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: Number(process.env.MOCK_CHUNK_DELAY_MS ?? 30) }) };
    },
  } as any);
}
