// The platform's own bookkeeping: deploys, unit versions, tags, workflow runs, secrets.
// Mastra's data (memory, snapshots, traces) lives in the separate libsql file, see storage.ts.
import { DatabaseSync } from 'node:sqlite';

/** A step is served as a one-step workflow, so it has Mastra's workflow routes. */
export type Kind = 'agent' | 'workflow' | 'step';
/** The Mastra route family a kind is served under. */
export const routeKind = (kind: Kind): 'agent' | 'workflow' => (kind === 'agent' ? 'agent' : 'workflow');
export type VersionRef = { unit: string; version: number };

export type VersionRow = {
  unit: string;
  version: number;
  repo: string;
  deploy: string;
  file: string;
  kind: Kind;
  fingerprint: string;
  info: unknown;
  created_at: number;
};

export type DeployRow = { id: string; repo: string; number: number; core: string; created_at: number; removed: number };
export type RunRow = { run_id: string; unit: string; version: number; status: string; created_at: number; updated_at: number };

/** Run statuses that mean the run still needs its version's code. */
export const OPEN_RUN_STATUSES = ['created', 'pending', 'running', 'suspended', 'waiting', 'paused'];

export class Registry {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists deploys  (id text primary key, repo text not null, number int not null, core text,
                                           created_at int not null, removed int not null default 0);
      create table if not exists versions (unit text not null, version int not null, repo text not null, deploy text not null,
                                           file text not null, kind text not null, fingerprint text not null, info json,
                                           created_at int not null, primary key (unit, version));
      create table if not exists tags     (unit text not null, tag text not null, version int not null, primary key (unit, tag));
      create table if not exists runs     (run_id text primary key, unit text not null, version int not null, status text not null,
                                           created_at int not null, updated_at int not null);
      create table if not exists secrets  (repo text not null, key text not null, value text not null, primary key (repo, key));
      create index if not exists versions_by_deploy on versions (deploy);
      create index if not exists runs_by_version on runs (unit, version);
    `);
  }

  close() {
    this.db.close();
  }

  // deploys ------------------------------------------------------------------

  nextDeployNumber(repo: string): number {
    const row = this.db.prepare('select max(number) as n from deploys where repo = ?').get(repo) as { n: number | null };
    return (row.n ?? 0) + 1;
  }

  addDeploy(d: { id: string; repo: string; number: number; core: string }) {
    this.db.prepare('insert into deploys (id, repo, number, core, created_at) values (?, ?, ?, ?, ?)').run(d.id, d.repo, d.number, d.core, Date.now());
  }

  deleteDeploy(id: string) {
    this.db.prepare('delete from versions where deploy = ?').run(id);
    this.db.prepare('delete from deploys where id = ?').run(id);
  }

  markDeployRemoved(id: string) {
    this.db.prepare('update deploys set removed = 1 where id = ?').run(id);
  }

  deploys(): DeployRow[] {
    return this.db.prepare('select * from deploys order by repo, number').all() as DeployRow[];
  }

  deploy(id: string): DeployRow | undefined {
    return this.db.prepare('select * from deploys where id = ?').get(id) as DeployRow | undefined;
  }

  /** The versions a deploy added. */
  versionsIn(deploy: string) {
    return this.db.prepare('select unit, version, kind from versions where deploy = ?').all(deploy) as Pick<VersionRow, 'unit' | 'version' | 'kind'>[];
  }

  /** True when the deploy is one of its repo's most recent `n`. */
  isRecent(d: DeployRow, n: number): boolean {
    const row = this.db.prepare('select count(*) as c from deploys where repo = ? and number > ?').get(d.repo, d.number) as { c: number };
    return row.c < n;
  }

  /** True when any version from this deploy carries a tag. */
  taggedIn(deploy: string): boolean {
    const row = this.db
      .prepare('select count(*) as c from tags t join versions v on v.unit = t.unit and v.version = t.version where v.deploy = ?')
      .get(deploy) as { c: number };
    return row.c > 0;
  }

  openRunsIn(deploy: string): number {
    const placeholders = OPEN_RUN_STATUSES.map(() => '?').join(',');
    const row = this.db
      .prepare(`select count(*) as c from runs r join versions v on v.unit = r.unit and v.version = r.version
                where v.deploy = ? and r.status in (${placeholders})`)
      .get(deploy, ...OPEN_RUN_STATUSES) as { c: number };
    return row.c;
  }

  // versions and tags --------------------------------------------------------

  ownerOf(unit: string): string | undefined {
    const row = this.db.prepare('select repo from versions where unit = ? limit 1').get(unit) as { repo: string } | undefined;
    return row?.repo;
  }

  nextVersion(unit: string): number {
    const row = this.db.prepare('select max(version) as v from versions where unit = ?').get(unit) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  addVersion(v: Omit<VersionRow, 'created_at' | 'info'>) {
    this.db
      .prepare('insert into versions (unit, version, repo, deploy, file, kind, fingerprint, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.unit, v.version, v.repo, v.deploy, v.file, v.kind, v.fingerprint, Date.now());
  }

  setInfo(ref: VersionRef, info: unknown) {
    this.db.prepare('update versions set info = ? where unit = ? and version = ?').run(JSON.stringify(info), ref.unit, ref.version);
  }

  version(ref: VersionRef): VersionRow | undefined {
    const row = this.db.prepare('select * from versions where unit = ? and version = ?').get(ref.unit, ref.version);
    return row && toVersion(row);
  }

  versions(unit: string): VersionRow[] {
    return this.db.prepare('select * from versions where unit = ? order by version').all(unit).map(toVersion);
  }

  /** Every unit id, sorted. */
  units(): string[] {
    return (this.db.prepare('select distinct unit from versions order by unit').all() as { unit: string }[]).map((r) => r.unit);
  }

  tags(unit: string): Record<string, number> {
    const rows = this.db.prepare('select tag, version from tags where unit = ?').all(unit) as { tag: string; version: number }[];
    return Object.fromEntries(rows.map((t) => [t.tag, t.version]));
  }

  tag(unit: string, tag: string, version: number) {
    this.db.prepare('insert into tags (unit, tag, version) values (?, ?, ?) on conflict (unit, tag) do update set version = excluded.version').run(unit, tag, version);
  }

  versionAt(unit: string, tag: string): VersionRow | undefined {
    const row = this.db.prepare('select version from tags where unit = ? and tag = ?').get(unit, tag) as { version: number } | undefined;
    return row ? this.version({ unit, version: row.version }) : undefined;
  }

  /** Every unit's prod version. */
  prodVersions(): VersionRow[] {
    return this.db
      .prepare(`select v.* from tags t join versions v on v.unit = t.unit and v.version = t.version where t.tag = 'prod' order by v.unit`)
      .all()
      .map(toVersion);
  }

  fingerprints(repo: string): Record<string, string> {
    return Object.fromEntries(this.prodVersions().filter((v) => v.repo === repo).map((v) => [v.unit, v.fingerprint]));
  }

  /**
   * 'supportAgent' → prod, 'supportAgent@v14' or 'supportAgent@14' → v14, 'supportAgent@canary' → that tag.
   * Returns undefined when the unit or the version doesn't exist.
   */
  resolve(idWithRef: string): (VersionRef & { kind: Kind }) | undefined {
    const [unit, ref = 'prod'] = idWithRef.split('@');
    const m = /^v?(\d+)$/.exec(ref);
    const row = m ? this.version({ unit, version: Number(m[1]) }) : this.versionAt(unit, ref);
    return row && { unit, version: row.version, kind: row.kind };
  }

  // runs ---------------------------------------------------------------------

  recordRun(runId: string, ref: VersionRef, status = 'created') {
    const now = Date.now();
    this.db
      .prepare('insert into runs (run_id, unit, version, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict (run_id) do nothing')
      .run(runId, ref.unit, ref.version, status, now, now);
  }

  setRunStatus(runId: string, status: string) {
    this.db.prepare('update runs set status = ?, updated_at = ? where run_id = ?').run(status, Date.now(), runId);
  }

  run(runId: string): RunRow | undefined {
    return this.db.prepare('select * from runs where run_id = ?').get(runId) as RunRow | undefined;
  }

  runs(limit = 200): RunRow[] {
    return this.db.prepare('select * from runs order by created_at desc limit ?').all(limit) as RunRow[];
  }

  /** Runs that may still need their version's code. */
  openRuns(): RunRow[] {
    return this.db.prepare(`select * from runs where status in (${OPEN_RUN_STATUSES.map(() => '?').join(',')})`).all(...OPEN_RUN_STATUSES) as RunRow[];
  }

  // secrets ------------------------------------------------------------------

  setSecrets(repo: string, values: Record<string, string>) {
    const stmt = this.db.prepare('insert into secrets (repo, key, value) values (?, ?, ?) on conflict (repo, key) do update set value = excluded.value');
    for (const [k, v] of Object.entries(values)) stmt.run(repo, k, String(v));
  }

  deleteSecret(repo: string, key: string) {
    this.db.prepare('delete from secrets where repo = ? and key = ?').run(repo, key);
  }

  secrets(repo: string): Record<string, string> {
    const rows = this.db.prepare('select key, value from secrets where repo = ?').all(repo) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}

const toVersion = (row: any): VersionRow => ({ ...row, info: row.info ? JSON.parse(row.info) : null });
