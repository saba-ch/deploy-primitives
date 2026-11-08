// Accepting a deploy: unpack it, add a version for every unit whose fingerprint changed, start
// and describe each new version, and only then move `prod`. One unit failing rejects the deploy.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { routeKind, type Kind, type Registry, type VersionRef } from './registry.ts';
import { key, type Runtime } from './runtime.ts';

export type Manifest = {
  repo: string;
  core: string;
  units: { kind: Kind; id: string; file: string; fingerprint: string }[];
};

export type UnitResult = {
  id: string;
  kind: Kind;
  status: 'new' | 'changed' | 'unchanged';
  version: number;
  from?: number;
};

export class DeployError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let queue: Promise<unknown> = Promise.resolve();
/** Deploys are applied one at a time. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export type AcceptContext = {
  home: string;
  registry: Registry;
  runtime: Runtime;
  cleanup: () => Promise<void>;
};

export const deployDir = (home: string, deploy: string) => join(home, 'deploys', deploy);

export function accept(ctx: AcceptContext, repo: string, body: ReadableStream<Uint8Array>) {
  return serialized(() => acceptNow(ctx, repo, body));
}

async function acceptNow({ home, registry, runtime, cleanup }: AcceptContext, repo: string, body: ReadableStream<Uint8Array>) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) throw new DeployError(400, `bad repo name ${repo}`);
  const number = registry.nextDeployNumber(repo);
  const id = `${repo}-${number}`;
  const dir = deployDir(home, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let registered = false;
  const created: { ref: VersionRef; kind: Kind; from?: VersionRef }[] = [];
  try {
    await pipeline(Readable.fromWeb(body as any), tar.x({ cwd: dir }));
    const manifest: Manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    if (manifest.repo !== repo) throw new DeployError(400, `manifest is for ${manifest.repo}, uploaded as ${repo}`);

    for (const u of manifest.units) {
      const owner = registry.ownerOf(u.id);
      if (owner && owner !== repo) throw new DeployError(409, `${u.id} already belongs to ${owner}`);
    }

    registry.addDeploy({ id, repo, number, core: manifest.core });
    registered = true;
    const results: UnitResult[] = [];
    for (const u of manifest.units) {
      const cur = registry.versionAt(u.id, 'prod');
      if (cur && cur.fingerprint === u.fingerprint && cur.kind === u.kind) {
        results.push({ id: u.id, kind: u.kind, status: 'unchanged', version: cur.version });
        continue;
      }
      const version = registry.nextVersion(u.id);
      registry.addVersion({ unit: u.id, version, repo, deploy: id, file: u.file, kind: u.kind, fingerprint: u.fingerprint });
      const from = cur ? { unit: u.id, version: cur.version } : undefined;
      created.push({ ref: { unit: u.id, version }, kind: u.kind, from });
      results.push({ id: u.id, kind: u.kind, status: cur ? 'changed' : 'new', version, from: cur?.version });
    }

    // Start every new version and describe it. The description is what GET /api/agents and
    // `pull` read later, so the platform never has to load an old version just to list it.
    const failures: { id: string; error: string }[] = [];
    await Promise.all(
      created.map(async ({ ref, kind }) => {
        const res = await runtime.fetch(ref, new Request(`http://platform.local/api/${routeKind(kind)}s/${encodeURIComponent(ref.unit)}`));
        const text = await res.text();
        if (!res.ok) {
          let error = text;
          try {
            error = JSON.parse(text).error ?? text;
          } catch {}
          failures.push({ id: ref.unit, error });
        } else registry.setInfo(ref, JSON.parse(text));
      }),
    );
    if (failures.length) {
      throw new DeployError(422, `deploy rejected: ${failures.map((f) => `${f.id}: ${f.error}`).join('; ')}`, { failures });
    }

    for (const { ref, from } of created) {
      registry.tag(ref.unit, 'prod', ref.version);
      if (from) runtime.drain(from);
    }
    void cleanup();
    return { deploy: id, repo, number, units: results };
  } catch (err) {
    for (const { ref } of created) runtime.endKey(key(ref), 'deploy rejected');
    if (registered) registry.deleteDeploy(id);
    await rm(dir, { recursive: true, force: true });
    if (err instanceof DeployError) throw err;
    throw new DeployError(400, `deploy failed: ${(err as Error).message}`);
  }
}
