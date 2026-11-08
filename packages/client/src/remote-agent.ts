// A reference to an agent deployed on the platform. It is an Agent, so createStep(remoteAgent)
// and other code that takes an Agent work unchanged; generate and stream go over the platform's
// HTTP API to that unit's thread.
import { MastraClient } from '@mastra/client-js';
import { Agent } from '@mastra/core/agent';
import { at, REMOTE } from './web';

let shared: MastraClient | undefined;
let sharedUrl: string | undefined;
/** Read at call time: inside a unit thread the platform sets MASTRA_PLATFORM_URL. */
export function client() {
  const url = process.env.MASTRA_PLATFORM_URL ?? 'http://localhost:4200';
  if (!shared || sharedUrl !== url) {
    shared = new MastraClient({ baseUrl: url });
    sharedUrl = url;
  }
  return shared;
}

// Never called: the real model lives with the deployed agent. createStep(agent) only checks its
// specificationVersion to pick the streaming path.
const remoteModel = (id: string) =>
  ({
    specificationVersion: 'v2',
    provider: 'platform',
    modelId: id,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error(`${id} runs on the platform`)),
    doStream: () => Promise.reject(new Error(`${id} runs on the platform`)),
  }) as any;

// Options that survive the trip over HTTP. Callbacks, signals and contexts stay local.
const WIRE_KEYS = ['memory', 'maxSteps', 'modelSettings', 'toolChoice', 'instructions', 'context', 'runId', 'resourceId', 'threadId', 'structuredOutput', 'providerOptions'];
const wire = (opts: Record<string, any> = {}) => Object.fromEntries(WIRE_KEYS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));

export class RemoteAgent extends Agent {
  readonly [REMOTE] = true;
  readonly ref: string;

  constructor({ id, ref = 'prod' }: { id: string; ref?: string }) {
    super({ id, name: id, instructions: '', model: remoteModel(id) });
    this.ref = ref;
  }

  get remote() {
    return client().getAgent(at(this.id, this.ref));
  }

  override async getModel(): Promise<any> {
    return remoteModel(this.id);
  }

  override async generate(messages: any, opts?: any): Promise<any> {
    return this.remote.generate(messages, wire(opts));
  }

  /** Returns the shape createStep(agent) reads: a fullStream of Mastra chunks and a text promise. */
  override async stream(messages: any, opts: any = {}): Promise<any> {
    const res = await this.remote.stream(messages, wire(opts));
    return adaptClientStream(res, opts);
  }
}

export const remoteAgent = (opts: { id: string; ref?: string }) => new RemoteAgent(opts);

function adaptClientStream(res: { processDataStream: (o: { onChunk: (c: any) => Promise<void> }) => Promise<void> }, opts: any) {
  let resolveText!: (t: string) => void;
  let rejectText!: (e: unknown) => void;
  const text = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });
  text.catch(() => {});
  let acc = '';
  let finish: any;
  const fullStream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          await res.processDataStream({
            onChunk: async (chunk) => {
              if (chunk?.type === 'text-delta') acc += chunk.payload?.text ?? '';
              if (chunk?.type === 'finish') finish = chunk.payload;
              if (chunk?.type === 'error') throw new Error(chunk.payload?.error?.message ?? 'remote agent error');
              controller.enqueue(chunk);
            },
          });
          controller.close();
          resolveText(acc);
          await opts.onFinish?.({ text: acc, ...finish });
        } catch (err) {
          controller.error(err);
          rejectText(err);
        }
      })();
    },
  });
  return { fullStream, text };
}
