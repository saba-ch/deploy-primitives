// One worker thread per unit version. `fetch(ref, request)` is the only way into a unit: it starts
// the thread if needed, hands the request over a MessagePort, and streams the response back.
import { MessageChannel, Worker } from 'node:worker_threads';
import type { Kind, VersionRef } from './registry.ts';

export type ThreadSpec = {
  kind: Kind;
  repo: string;
  deploy: string;
  dir: string;
  file: string;
  env: Record<string, string>;
};

export type ThreadState = 'starting' | 'serving' | 'draining' | 'ended';

type PendingCall = { fail: (status: number, message: string) => void };

export type UnitThread = {
  key: string;
  ref: VersionRef;
  kind: Kind;
  repo: string;
  deploy: string;
  worker: Worker;
  ready: Promise<void>;
  loaded: boolean;
  ended: boolean;
  inFlight: number;
  calls: number;
  startedAt: number;
  lastUsed: number;
  /** A thread started for a version that isn't prod yet (deploy describe) is kept until then. */
  keepUntil: number;
  /** Its repo's secrets changed: it drains even while prod, and the next thread gets the new env. */
  retired?: boolean;
  pending: Set<PendingCall>;
  endReason?: string;
};

export type RuntimeOptions = {
  spec: (ref: VersionRef) => ThreadSpec;
  isProd: (ref: VersionRef) => boolean;
  storageUrl: string;
  callTimeoutMs?: number;
  idleMs?: number;
  drainGraceMs?: number;
  maxOldGenerationSizeMb?: number;
  log?: (msg: string) => void;
};

const NULL_BODY = new Set([101, 204, 205, 304]);
export const key = (ref: VersionRef) => `${ref.unit}@${ref.version}`;

export class Runtime {
  threads = new Map<string, UnitThread>();
  #opts: Required<RuntimeOptions>;
  #sweep: NodeJS.Timeout;
  #workerUrl = new URL('../unit-host.mjs', import.meta.url);

  constructor(opts: RuntimeOptions) {
    this.#opts = {
      callTimeoutMs: Number(process.env.PLATFORM_CALL_TIMEOUT_MS ?? 300_000),
      idleMs: Number(process.env.PLATFORM_IDLE_MS ?? 5 * 60_000),
      drainGraceMs: Number(process.env.PLATFORM_DRAIN_GRACE_MS ?? 1_000),
      maxOldGenerationSizeMb: Number(process.env.PLATFORM_THREAD_HEAP_MB ?? 512),
      log: (m) => console.log(m),
      ...opts,
    };
    this.#sweep = setInterval(() => this.sweep(), 1_000);
    this.#sweep.unref();
  }

  async fetch(ref: VersionRef, req: Request): Promise<Response> {
    let t = this.threads.get(key(ref));
    if (!t || t.ended) t = this.start(ref);
    try {
      await t.ready;
    } catch (err: any) {
      return Response.json({ error: `${key(ref)} failed to load: ${err.message}` }, { status: 503 });
    }
    if (t.ended) return Response.json({ error: `${key(ref)} ended before the call started` }, { status: 503 });
    return this.#call(t, req);
  }

  start(ref: VersionRef): UnitThread {
    const spec = this.#opts.spec(ref);
    const k = key(ref);
    const worker = new Worker(this.#workerUrl, {
      name: k,
      workerData: { dir: spec.dir, file: spec.file, kind: spec.kind, id: ref.unit, storage: this.#opts.storageUrl },
      env: spec.env, // this thread's process.env, nothing else
      resourceLimits: { maxOldGenerationSizeMb: this.#opts.maxOldGenerationSizeMb },
    });
    const now = Date.now();
    const t: UnitThread = {
      key: k,
      ref,
      kind: spec.kind,
      repo: spec.repo,
      deploy: spec.deploy,
      worker,
      ready: null as unknown as Promise<void>,
      loaded: false,
      ended: false,
      inFlight: 0,
      calls: 0,
      startedAt: now,
      lastUsed: now,
      keepUntil: now + 30_000,
      pending: new Set(),
    };
    t.ready = new Promise<void>((resolve, reject) => {
      worker.once('message', (m) => {
        if (m?.ready) {
          t.loaded = true;
          resolve();
        } else {
          reject(new Error(m?.error?.message ?? 'unit host failed'));
          this.end(t, 'load failed');
        }
      });
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`thread exited with code ${code} while loading`)));
    });
    t.ready.catch(() => {});
    worker.on('error', (err: Error) => this.#opts.log(`[runtime] ${k} crashed: ${err.message}`));
    worker.on('exit', (code) => {
      t.ended = true;
      t.endReason ??= `exit ${code}`;
      if (this.threads.get(k) === t) this.threads.delete(k);
      for (const p of [...t.pending]) p.fail(502, `${k} thread exited (${t.endReason}) during the call`);
      this.#opts.log(`[runtime] ${k} ended: ${t.endReason}`);
    });
    this.threads.set(k, t);
    this.#opts.log(`[runtime] ${k} starting`);
    return t;
  }

  end(t: UnitThread, reason: string) {
    if (t.ended) return;
    t.endReason ??= reason;
    t.ended = true;
    if (this.threads.get(t.key) === t) this.threads.delete(t.key);
    void t.worker.terminate();
  }

  endKey(k: string, reason = 'ended by request'): boolean {
    const t = this.threads.get(k);
    if (!t) return false;
    this.end(t, reason);
    return true;
  }

  /** Ends the thread once its in-flight calls finish (it's no longer prod, so the sweep picks it up). */
  drain(ref: VersionRef) {
    const t = this.threads.get(key(ref));
    if (t) t.keepUntil = 0;
    this.sweep();
  }

  /** Ends every thread of a repo once idle, so the next call picks up new secrets. */
  drainRepo(repo: string) {
    for (const t of this.threads.values()) if (t.repo === repo) Object.assign(t, { retired: true, keepUntil: 0 });
    this.sweep();
  }

  state(t: UnitThread): ThreadState {
    if (t.ended) return 'ended';
    if (!t.loaded) return 'starting';
    return this.#opts.isProd(t.ref) && !t.retired ? 'serving' : 'draining';
  }

  sweep() {
    const now = Date.now();
    for (const t of [...this.threads.values()]) {
      if (!t.loaded || t.inFlight > 0) continue;
      const idle = now - t.lastUsed;
      if (this.state(t) === 'draining' && now >= t.keepUntil && idle >= this.#opts.drainGraceMs) this.end(t, 'drained');
      else if (idle >= this.#opts.idleMs) this.end(t, 'idle');
    }
  }

  hasThreadsFor(deploy: string): boolean {
    return [...this.threads.values()].some((t) => t.deploy === deploy);
  }

  async list() {
    return Promise.all(
      [...this.threads.values()].map(async (t) => {
        let heapUsed: number | null = null;
        try {
          if (t.loaded && !t.ended) heapUsed = (await t.worker.getHeapStatistics()).used_heap_size;
        } catch {}
        return {
          key: t.key,
          unit: t.ref.unit,
          version: t.ref.version,
          kind: t.kind,
          repo: t.repo,
          deploy: t.deploy,
          threadId: t.worker.threadId,
          state: this.state(t),
          inFlight: t.inFlight,
          calls: t.calls,
          heapUsed,
          startedAt: t.startedAt,
          lastUsed: t.lastUsed,
        };
      }),
    );
  }

  async close() {
    clearInterval(this.#sweep);
    await Promise.all([...this.threads.values()].map((t) => t.worker.terminate()));
    this.threads.clear();
  }

  #call(t: UnitThread, req: Request): Promise<Response> {
    t.inFlight++;
    t.calls++;
    t.lastUsed = Date.now();
    const { port1, port2 } = new MessageChannel();
    const body = req.body;
    const transfer: any[] = body ? [port2, body] : [port2];
    t.worker.postMessage({ url: req.url, method: req.method, headers: [...req.headers], body, port: port2 }, transfer);

    return new Promise<Response>((resolve) => {
      let responded = false;
      let finished = false;
      let bodyCtl: ReadableStreamDefaultController<Uint8Array> | null = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        t.inFlight--;
        t.lastUsed = Date.now();
        t.pending.delete(call);
        port1.close();
      };
      const call: PendingCall = {
        fail: (status, message) => {
          if (!responded) {
            responded = true;
            resolve(Response.json({ error: message }, { status }));
          } else {
            try {
              bodyCtl?.error(new Error(message));
            } catch {}
          }
          finish();
        },
      };
      t.pending.add(call);

      const timer = setTimeout(() => {
        call.fail(504, `call to ${t.key} timed out after ${this.#opts.callTimeoutMs}ms; its thread was ended`);
        this.end(t, 'call timeout');
      }, this.#opts.callTimeoutMs);

      port1.once('message', (m: any) => {
        if (finished) return;
        responded = true;
        if (m.error) {
          resolve(Response.json({ error: m.error.message }, { status: 500 }));
          return finish();
        }
        const headers = new Headers(m.headers);
        if (!m.body || NULL_BODY.has(m.status)) {
          m.body?.cancel().catch(() => {});
          resolve(new Response(null, { status: m.status, statusText: m.statusText, headers }));
          return finish();
        }
        // inFlight drops when the body closes, errors, or the caller cancels it.
        const reader = (m.body as ReadableStream<Uint8Array>).getReader();
        const out = new ReadableStream<Uint8Array>({
          start: (c) => {
            bodyCtl = c;
          },
          pull: async (c) => {
            try {
              const { done, value } = await reader.read();
              if (finished) return;
              if (done) {
                c.close();
                finish();
              } else c.enqueue(value);
            } catch (err) {
              try {
                c.error(err);
              } catch {}
              finish();
            }
          },
          cancel: (reason) => {
            reader.cancel(reason).catch(() => {});
            finish();
          },
        });
        resolve(new Response(out, { status: m.status, statusText: m.statusText, headers }));
      });
    });
  }
}
