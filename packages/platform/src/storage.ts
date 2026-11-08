// The shared Mastra storage and the main-thread "catalog" server. The catalog is a Mastra with the
// shared storage and no units: it answers the /api routes that aren't about one unit (memory,
// traces, logs, providers, ...) so Studio and client-js see one Mastra server.
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MastraServer } from '@mastra/hono';
import { Hono } from 'hono';

export async function createCatalog(url: string) {
  const storage = new LibSQLStore({ id: 'platform', url });
  const mastra = new Mastra({ storage });
  const app = new Hono();
  await new MastraServer({ app, mastra }).init();

  const workflows = storage.getStore('workflows');
  /** A run's status from its snapshot (read in SQL, the snapshot itself isn't loaded). */
  async function runStatus(workflowName: string, runId: string): Promise<string | undefined> {
    try {
      return (await (await workflows)?.loadWorkflowRunStatus({ workflowName, runId })) ?? undefined;
    } catch {
      return undefined;
    }
  }

  return { app, runStatus };
}
