// The platform process: one HTTP server on localhost:4200.
//   /api/…        Mastra's own routes. Per-unit routes go to that unit's thread; the rest to the catalog.
//   /_platform/…  the CLI and dashboard.
//   /_dashboard   a static page over /_platform.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { accept, DeployError, deployDir } from './accept.ts';
import { Registry, routeKind, type VersionRef } from './registry.ts';
import { key, Runtime } from './runtime.ts';
import { createCatalog } from './storage.ts';

export type PlatformOptions = { port?: number; home?: string; hostname?: string; keepDeploys?: number };

/** Ids under /api/agents and /api/workflows that are Mastra routes, not units. */
const RESERVED: Record<string, Set<string>> = {
  agents: new Set(['providers']),
  workflows: new Set(['events', 'run-counts']),
};
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function startPlatform(opts: PlatformOptions = {}) {
  const home = opts.home ?? process.env.MASTRA_PLATFORM_HOME ?? join(homedir(), '.mastra-platform');
  const keepDeploys = opts.keepDeploys ?? 5;
  await mkdir(join(home, 'deploys'), { recursive: true });

  const registry = new Registry(join(home, 'platform.sqlite'));
  const mastraDb = `file:${home}/mastra.db`;
  const catalog = await createCatalog(mastraDb);
  let platformUrl = '';

  const isProd = (ref: VersionRef) => registry.versionAt(ref.unit, 'prod')?.version === ref.version;
  const runtime = new Runtime({
    storageUrl: mastraDb,
    isProd,
    spec: (ref) => {
      const v = registry.version(ref);
      if (!v) throw new Error(`no such version ${ref.unit}@${ref.version}`);
      return {
        kind: v.kind,
        repo: v.repo,
        deploy: v.deploy,
        dir: deployDir(home, v.deploy),
        file: v.file,
        env: { ...registry.secrets(v.repo), MASTRA_PLATFORM_URL: platformUrl, MASTRA_TELEMETRY_DISABLED: '1' },
      };
    },
  });

  /** Brings `runs.status` up to date from Mastra's own snapshots, the only source of run status. */
  async function refreshRuns() {
    await Promise.all(
      registry.openRuns().map(async (r) => {
        const status = await catalog.runStatus(r.unit, r.run_id);
        if (status && status !== r.status) registry.setRunStatus(r.run_id, status);
      }),
    );
  }

  /** A deploy folder goes when nothing is tagged in it, no open run is pinned to it, and it isn't recent. */
  async function cleanup() {
    await refreshRuns();
    for (const d of registry.deploys()) {
      if (d.removed) continue;
      if (registry.taggedIn(d.id) || registry.openRunsIn(d.id) > 0 || registry.isRecent(d, keepDeploys) || runtime.hasThreadsFor(d.id)) continue;
      await rm(deployDir(home, d.id), { recursive: true, force: true });
      registry.markDeployRemoved(d.id);
      console.log(`[platform] removed deploy folder ${d.id}`);
    }
  }
  const cleanupTimer = setInterval(() => void cleanup().catch(() => {}), 60_000);
  cleanupTimer.unref();

  const app = new Hono();
  app.use('*', cors({ origin: (o) => (LOCALHOST.test(o) ? o : null), exposeHeaders: ['x-platform-unit', 'x-platform-thread'], credentials: true }));

  // --- dashboard ---------------------------------------------------------------------------
  app.get('/_dashboard', async (c) => c.html(await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8')));
  app.get('/', (c) => c.redirect('/_dashboard'));

  // --- /_platform: CLI and dashboard -------------------------------------------------------
  const p = new Hono();
  p.onError((err, c) => {
    if (err instanceof DeployError) return c.json({ error: err.message, ...(err.details as object) }, err.status as any);
    console.error('[platform]', err);
    return c.json({ error: err.message }, 500);
  });
  p.get('/health', (c) => {
    const m = process.memoryUsage();
    return c.json({ ok: true, rss: m.rss, heapUsed: m.heapUsed, threads: runtime.threads.size });
  });
  p.post('/gc', async (c) => {
    (globalThis as any).gc?.();
    await new Promise((r) => setTimeout(r, 50));
    (globalThis as any).gc?.();
    return c.json({ gc: typeof (globalThis as any).gc === 'function', rss: process.memoryUsage().rss });
  });
  p.get('/repos/:repo/fingerprints', (c) => c.json(registry.fingerprints(c.req.param('repo'))));
  p.put('/deploys/:repo', async (c) => {
    const body = c.req.raw.body;
    if (!body) throw new DeployError(400, 'empty upload');
    const result = await accept({ home, registry, runtime, cleanup }, c.req.param('repo'), body);
    console.log(`[platform] accepted ${result.deploy}: ${result.units.map((u) => `${u.id} ${u.status} v${u.version}`).join(', ')}`);
    return c.json(result);
  });
  p.get('/deploys', async (c) => {
    await refreshRuns();
    return c.json(
      registry.deploys().map((d) => ({
        ...d,
        removed: !!d.removed,
        units: registry.versionsIn(d.id),
        tagged: registry.taggedIn(d.id),
        openRuns: registry.openRunsIn(d.id),
        threads: runtime.hasThreadsFor(d.id),
        recent: registry.isRecent(d, keepDeploys),
      })),
    );
  });
  const unitView = (unit: string) => {
    const versions = registry.versions(unit);
    if (!versions.length) return null;
    const prod = registry.versionAt(unit, 'prod');
    return {
      id: unit,
      kind: versions[0].kind,
      repo: versions[0].repo,
      tags: registry.tags(unit),
      prod: prod && { version: prod.version, fingerprint: prod.fingerprint, deploy: prod.deploy },
      versions: versions.map((v) => ({ version: v.version, deploy: v.deploy, fingerprint: v.fingerprint, createdAt: v.created_at })),
      info: prod?.info ?? null,
    };
  };
  p.get('/units', (c) => c.json(registry.units().map(unitView)));
  p.get('/units/:id', (c) => {
    const view = unitView(c.req.param('id'));
    return view ? c.json(view) : c.json({ error: 'not found' }, 404);
  });
  p.put('/units/:id/tags/:tag', async (c) => {
    const unit = c.req.param('id');
    const { version } = await c.req.json<{ version: number | string }>();
    const n = Number(String(version).replace(/^v/, ''));
    const target = registry.version({ unit, version: n });
    if (!target) return c.json({ error: `${unit} has no v${n}` }, 404);
    if (registry.deploy(target.deploy)?.removed)
      return c.json({ error: `${unit} v${n} was in ${target.deploy}, whose folder has been cleaned up (only the last ${keepDeploys} deploys are kept)` }, 409);
    const before = registry.versionAt(unit, c.req.param('tag'));
    registry.tag(unit, c.req.param('tag'), n);
    if (before && before.version !== n) runtime.drain({ unit, version: before.version });
    return c.json({ unit, tag: c.req.param('tag'), version: n, from: before?.version ?? null });
  });
  p.get('/repos/:repo/secrets', (c) => c.json({ keys: Object.keys(registry.secrets(c.req.param('repo'))) }));
  p.put('/repos/:repo/secrets', async (c) => {
    const repo = c.req.param('repo');
    registry.setSecrets(repo, await c.req.json());
    runtime.drainRepo(repo);
    return c.json({ keys: Object.keys(registry.secrets(repo)) });
  });
  p.delete('/repos/:repo/secrets/:key', (c) => {
    registry.deleteSecret(c.req.param('repo'), c.req.param('key'));
    runtime.drainRepo(c.req.param('repo'));
    return c.json({ ok: true });
  });
  p.get('/threads', async (c) => c.json(await runtime.list()));
  p.delete('/threads/:key', (c) => c.json({ ended: runtime.endKey(c.req.param('key')) }));
  p.get('/runs', async (c) => {
    await refreshRuns();
    return c.json(registry.runs());
  });
  p.post('/cleanup', async (c) => {
    await cleanup();
    return c.json({ ok: true });
  });
  app.route('/_platform', p);

  // --- /api: Mastra's routes ---------------------------------------------------------------
  const listUnits = (route: 'agent' | 'workflow') => (c: any) =>
    c.json(
      Object.fromEntries(
        registry
          .prodVersions()
          .filter((v) => routeKind(v.kind) === route)
          .map((v) => [v.unit, { ...(v.info as object), id: v.unit, platform: { repo: v.repo, version: v.version, deploy: v.deploy, kind: v.kind } }]),
      ),
    );
  app.get('/api/agents', listUnits('agent'));
  app.get('/api/workflows', listUnits('workflow'));

  app.all('/api/*', async (c) => {
    const raw = c.req.raw;
    const url = new URL(raw.url);
    /** The same request, to `url`, on `ref`'s thread. */
    const forward = async (ref: VersionRef) => {
      const hasBody = !['GET', 'HEAD'].includes(raw.method);
      const init = { method: raw.method, headers: raw.headers, body: hasBody ? raw.body : null, duplex: 'half', signal: raw.signal };
      const res = await runtime.fetch(ref, new Request(url, init as RequestInit));
      res.headers.set('x-platform-unit', `${ref.unit}@v${ref.version}`);
      const t = runtime.threads.get(key(ref));
      if (t) res.headers.set('x-platform-thread', String(t.worker.threadId));
      return res;
    };

    // Memory config lives with the agent, so memory calls that name a deployed agent go to its thread.
    const memoryAgent = url.pathname.startsWith('/api/memory/') && url.searchParams.get('agentId');
    if (memoryAgent) {
      const r = registry.resolve(memoryAgent);
      if (r?.kind === 'agent') {
        url.searchParams.set('agentId', r.unit);
        return forward(r);
      }
    }

    const m = /^\/api\/(agents|workflows)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m || RESERVED[m[1]].has(decodeURIComponent(m[2]))) return catalog.app.fetch(c.req.raw);

    const [, plural, rawId, rest = ''] = m;
    const kind = plural === 'agents' ? 'agent' : 'workflow';
    const idWithRef = decodeURIComponent(rawId);
    const resolved = registry.resolve(idWithRef);
    if (!resolved || routeKind(resolved.kind) !== kind) return c.json({ error: `${kind} ${idWithRef} not found` }, 404);

    // A run stays on the version it was created on.
    let ref: VersionRef = { unit: resolved.unit, version: resolved.version };
    const runId = url.searchParams.get('runId') ?? /^\/runs\/([^/]+)/.exec(rest)?.[1];
    const pinned = runId ? registry.run(decodeURIComponent(runId)) : undefined;
    if (pinned && pinned.unit === ref.unit) ref = { unit: pinned.unit, version: pinned.version };

    // Mastra's handler sees the plain id: 'supportAgent@v14' → 'supportAgent'.
    url.pathname = `/api/${plural}/${encodeURIComponent(ref.unit)}${rest}`;
    const res = await forward(ref);

    // Pin a run to the version that first served it; its status comes from storage (refreshRuns).
    if (kind === 'workflow' && res.ok && !pinned) {
      const run = rest === '/create-run' ? (await res.clone().json()).runId : runId;
      if (run) registry.recordRun(run, ref);
    }
    return res;
  });

  const server = serve({ fetch: app.fetch, port: opts.port ?? 4200, hostname: opts.hostname ?? '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port ?? 4200;
  platformUrl = `http://localhost:${port}`;

  return {
    url: platformUrl,
    port,
    home,
    registry,
    runtime,
    async close() {
      clearInterval(cleanupTimer);
      await runtime.close();
      await new Promise((r) => server.close(() => r(null)));
      registry.close();
    },
  };
}
