// Each test spawns its own platform (temp home, free port) and runs the CLI against a fresh copy
// of an example repo. Copies live in the OS temp dir and get a node_modules of symlinks to the example's
// own packages, so a test can add a package without touching the example.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MastraClient } from '@mastra/client-js';
import { afterAll } from 'vitest';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_BIN = join(ROOT, 'packages/cli/bin/mastra-platform.mjs');
// Outside the workspace, so no ancestor node_modules can mask a package the copy can't resolve.
const TMP = join(tmpdir(), 'mastra-platform-e2e');

const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.reverse().map((f) => f()));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export type Platform = Awaited<ReturnType<typeof startPlatform>>;

export async function startPlatform({ env = {} }: { env?: Record<string, string> } = {}) {
  await mkdir(TMP, { recursive: true });
  const home = await mkdtemp(join(TMP, 'home-'));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--expose-gc', CLI_BIN, 'start', '--port', String(port), '--home', home], {
    env: { ...process.env, PLATFORM_DRAIN_GRACE_MS: '200', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout!.on('data', (d) => (logs += d));
  child.stderr!.on('data', (d) => (logs += d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`platform didn't start:\n${logs}`)), 30_000);
    const check = () => logs.includes('platform listening') && (clearTimeout(t), resolve());
    child.stdout!.on('data', check);
    child.on('exit', (code) => reject(new Error(`platform exited ${code}:\n${logs}`)));
  });
  const url = `http://localhost:${port}`;
  process.env.MASTRA_PLATFORM_URL = url;

  const get = async (path: string) => {
    const res = await fetch(url + path);
    return res.json() as Promise<any>;
  };
  const post = async (path: string) => {
    const res = await fetch(url + path, { method: 'POST' });
    return res.json() as Promise<any>;
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  };
  cleanups.push(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });
  return {
    url,
    port,
    home,
    child,
    logs: () => logs,
    get,
    post,
    stop,
    client: new MastraClient({ baseUrl: url }),
    unit: (id: string) => get(`/_platform/units/${id}`),
    threads: () => get('/_platform/threads') as Promise<any[]>,
    thread: async (key: string) => (await get('/_platform/threads')).find((t: any) => t.key === key),
    deploys: () => get('/_platform/deploys') as Promise<any[]>,
    health: () => get('/_platform/health'),
  };
}

export async function copyExample(name: string) {
  const src = join(ROOT, 'examples', name);
  await mkdir(TMP, { recursive: true });
  const dst = await mkdtemp(join(TMP, `${name}-`));
  await cp(src, dst, {
    recursive: true,
    filter: (p) => !/\/(node_modules|\.platform|_generated|dist)(\/|$)/.test(p.slice(src.length)),
  });
  // node_modules: a real folder of symlinks, so tests can add packages to it
  const nm = join(dst, 'node_modules');
  await mkdir(nm);
  for (const entry of await readdir(join(src, 'node_modules'))) {
    if (entry.startsWith('@')) {
      await mkdir(join(nm, entry));
      for (const sub of await readdir(join(src, 'node_modules', entry))) await symlink(join(src, 'node_modules', entry, sub), join(nm, entry, sub));
    } else await symlink(join(src, 'node_modules', entry), join(nm, entry));
  }
  cleanups.push(() => rm(dst, { recursive: true, force: true }));
  return dst;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** Runs the platform CLI in `repo` and returns its stdout; throws on a non-zero exit. */
export async function cli(repo: string, ...args: string[]) {
  const r = await cliResult(repo, ...args);
  if (r.code !== 0) throw new Error(`mastra-platform ${args.join(' ')} failed (${r.code}):\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

export const cliResult = (repo: string, ...args: string[]) => run(process.execPath, [CLI_BIN, ...args], { cwd: repo });

export async function edit(repo: string, file: string, fn: (s: string) => string) {
  const path = join(repo, file);
  const before = await readFile(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`edit of ${file} changed nothing`);
  await writeFile(path, after);
}

export async function write(repo: string, file: string, contents: string) {
  await mkdir(dirname(join(repo, file)), { recursive: true });
  await writeFile(join(repo, file), contents);
}

/** Streams supportAgent-style text and returns it with timing. */
export async function streamText(client: MastraClient, agentId: string, prompt: string) {
  const t0 = Date.now();
  let first = 0;
  let text = '';
  const res = await client.getAgent(agentId).stream(prompt);
  await res.processDataStream({
    onChunk: async (c: any) => {
      if (c.type === 'text-delta') {
        first ||= Date.now() - t0;
        text += c.payload.text;
      }
    },
  });
  return { text, firstChunkMs: first, totalMs: Date.now() - t0, headers: res.headers };
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}
