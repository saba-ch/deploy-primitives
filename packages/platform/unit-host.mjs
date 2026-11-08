// Runs inside every unit thread: loads one unit into a one-unit Mastra and serves Mastra's own
// routes (via @mastra/hono) for it. The main thread hands each request over a MessagePort and gets
// back status, headers and the body as a transferred ReadableStream.
import { enableCompileCache } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { resolvePlatformPkgsFrom } from './src/platform-pkgs.ts';

// Each thread is a fresh isolate: reuse compiled code for core, libsql and hono across threads.
enableCompileCache();
// @mastra/core and zod come from the platform, never from the deploy folder.
resolvePlatformPkgsFrom(import.meta.url);

// A stray rejection inside unit code shouldn't take the whole thread down.
process.on('unhandledRejection', (err) => console.error(`[${workerData.id}] unhandled rejection:`, err));

const { dir, file, kind, id, storage } = workerData;

try {
  // dynamic, so the hooks are in place first
  const [{ Mastra }, { Agent }, { Workflow }, { LibSQLStore }, { MastraServer }, { Hono }] = await Promise.all([
    import('@mastra/core'),
    import('@mastra/core/agent'),
    import('@mastra/core/workflows'),
    import('@mastra/libsql'),
    import('@mastra/hono'),
    import('hono'),
  ]);

  // A published step was built as a one-step workflow, so anything but an agent is a workflow here.
  const unit = (await import(pathToFileURL(join(dir, file)).href)).default;
  const Expected = kind === 'agent' ? Agent : Workflow;
  if (!(unit instanceof Expected)) {
    const looksRight = unit && typeof unit === 'object' && unit.id === id;
    throw new Error(
      looksRight
        ? `${id} was built against its own copy of @mastra/core; it must come from the platform (unit bundles its own @mastra/core)`
        : `${file} does not default-export a${kind === 'agent' ? 'n agent' : ' workflow'}`,
    );
  }

  const mastra = new Mastra({
    [kind === 'agent' ? 'agents' : 'workflows']: { [id]: unit },
    storage: new LibSQLStore({ id: 'platform', url: storage }),
  });
  const app = new Hono();
  await new MastraServer({ app, mastra }).init();

  const encoder = new TextEncoder();
  const asBytes = () =>
    new TransformStream({ transform: (c, ctl) => ctl.enqueue(typeof c === 'string' ? encoder.encode(c) : c) });

  parentPort.on('message', async ({ url, method, headers, body, port }) => {
    try {
      const req = new Request(url, { method, headers, body: body ?? undefined, duplex: 'half' });
      const res = await app.fetch(req);
      const out = res.body ? res.body.pipeThrough(asBytes()) : null;
      port.postMessage(
        { status: res.status, statusText: res.statusText, headers: [...res.headers], body: out },
        out ? [out] : [],
      );
    } catch (err) {
      port.postMessage({ error: { message: err?.message ?? String(err), stack: err?.stack } });
    }
  });

  parentPort.postMessage({ ready: true });
} catch (err) {
  parentPort.postMessage({ error: { message: err?.message ?? String(err), stack: err?.stack } });
}
