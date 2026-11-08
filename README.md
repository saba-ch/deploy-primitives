# Deploy primitives, not servers

Deploy a Mastra agent, workflow or step on its own, then call it from any repo, server or browser, with types. There's no server to write.

```
support-team ──deploy──▶ ┌──────────────── platform ─────────────────┐
                         │ supportAgent      agent     v1  v2 ◀ prod │
ops-team ◀────pull────── │ escalateWorkflow  workflow  v1 ◀ prod     │
         ─────deploy───▶ │ classifyTicket    step      v1 ◀ prod     │
                         │ triageWorkflow    workflow  v1 ◀ prod     │
web app ──────call─────▶ └───────────────────────────────────────────┘

support-team  exports supportAgent, escalateWorkflow, classifyTicket
ops-team      triageWorkflow: classifyTicket → supportAgent
web app       chats with supportAgent, starts triageWorkflow
```

## 1. Write Mastra the way you already do

```ts
export const supportAgent = new Agent({
  id: 'supportAgent',
  instructions: 'You help customers with orders and refunds.',
  model: 'mastra/openai/gpt-6-luna',
  tools: { lookupOrder, issueRefund },
});

export const classifyTicket = createStep({
  id: 'classifyTicket',
  inputSchema: Ticket,
  outputSchema: Ticket.extend({ queue: z.string(), priority: z.string() }),
  execute: async ({ inputData }) => classify(inputData),
});

export const escalateWorkflow = createWorkflow({ id: 'escalateWorkflow', ... })
  .then(triage)
  .then(approve) // suspends until someone approves
  .commit();
```

Every agent, workflow and step you export is deployed by itself. You don't write `new Mastra()` or a server.

## 2. Deploy

```bash
mastra-platform deploy
```

```
  supportAgent      new  v1
  escalateWorkflow  new  v1
  classifyTicket    new  v1
  uploaded as support-team #1
```

## 3. Build on it from another repo

`pull` writes a typed `api` for everything deployed:

```bash
mastra-platform pull
```

Compose another team's step and agent into your own workflow:

```ts
import { api } from '../_generated/api';

export const triageWorkflow = createWorkflow({ id: 'triageWorkflow', ... })
  .then(api.steps.classifyTicket)            // support-team's step
  .map(async ({ inputData }) => ({ prompt: `Reply to: ${inputData.text}` }))
  .then(createStep(api.agents.supportAgent)) // support-team's agent
  .commit();
```

Deploy it, and it's published too:

```
  triageWorkflow  new  v1
  uploaded as ops-team #1
```

Each piece runs where it's deployed: `triageWorkflow` calls `classifyTicket` and `supportAgent` through the platform.

## 4. Call it

From a server (a route, a queue consumer, a cron job):

```ts
import { api } from './mastra/_generated/api';

export async function answer(question: string) {
  const { text } = await api.agents.supportAgent.generate(question);
  return text;
}

export function escalate(ticketId: string, reason: string) {
  // resolves as 'suspended': the workflow waits for someone to approve
  return api.workflows.escalateWorkflow.start({ ticketId, reason });
}
```

From a React component (`pull --target web`):

```tsx
import { useChat } from '@mastra/platform-client/react';
import { api, type TriageWorkflowInput } from './_generated/api';

function SupportChat() {
  const { messages, sendMessage } = useChat(api.agents.supportAgent);
  return <Chat messages={messages} onSend={sendMessage} />;
}

function TriageButton({ ticket }: { ticket: TriageWorkflowInput }) {
  const triage = () => api.workflows.triageWorkflow.start(ticket);
  return <button onClick={triage}>Triage</button>;
}
```

From anything else. It's Mastra's own API, so Studio works too:

```bash
curl localhost:4200/api/agents/supportAgent/generate \
  -H 'content-type: application/json' -d '{"messages":"Where is order A-17?"}'
```

## 5. Change it

Edit one tool and deploy again. Only what changed gets a new version:

```
  supportAgent      changed    v1 → v2
  escalateWorkflow  unchanged  v1
  classifyTicket    unchanged  v1
```

- New calls go to v2. v1 finishes what it's doing, then stops.
- A workflow waiting for approval resumes on the version it started on.
- Pin a version with `supportAgent@v1`, or `remoteAgent({ id: 'supportAgent', ref: 'v1' })`.

Roll back:

```bash
mastra-platform rollback supportAgent 1
```

When a unit you call changes its input or output, your next `pull` turns that into a `tsc` error.

## 6. Secrets

Only this repo's agents, workflows and steps see them:

```bash
mastra-platform secrets set MASTRA_GATEWAY_API_KEY=...
```

## Under the hood

```
call ──▶ platform :4200 ──▶ supportAgent@prod = v2 ──▶ v2's own thread

v2's thread: Mastra's own server, one unit, this repo's secrets
```

Each version starts on its first call and stops when idle. A step is served as a one-step workflow, so it gets runs, pinning and Studio for free. For now this runs on your machine only, and threads aren't a sandbox.

## Try it

From this folder:

```bash
pnpm install
pnpm exec mastra-platform start   # keep it running
pnpm -C examples/support-team exec mastra-platform deploy
pnpm -C examples/ops-team exec mastra-platform pull
pnpm -C examples/ops-team exec mastra-platform deploy
pnpm -C examples/web exec mastra-platform pull --target web
pnpm -C examples/web dev          # localhost:5173
```

The dashboard is at http://localhost:4200/_dashboard, and `pnpm test` runs every scenario end to end.
