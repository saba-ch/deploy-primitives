// A browser app on the platform, using the typed `api` that `mastra-platform pull --target web`
// writes to src/_generated/api.ts: a chat with support-team's agent (drawn with AI Elements),
// ops-team's triageWorkflow, and support-team's escalateWorkflow.
import { useChat } from '@mastra/platform-client/react';
import { MastraReactProvider, type MastraDBMessage, type MastraMessagePart } from '@mastra/react';
import type { ChatStatus, DynamicToolUIPart } from 'ai';
import { BotIcon } from 'lucide-react';
import { useState } from 'react';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api, baseUrl, type EscalateWorkflowOutput, type TriageWorkflowOutput } from './_generated/api';

const SUGGESTIONS = ['Where is order A-17?', 'Can I get a refund for order B-42?', 'What can you help with?'];

type ToolInvocation = Extract<MastraMessagePart, { type: 'tool-invocation' }>['toolInvocation'];

/** Mastra's tool states, in AI Elements' (AI SDK v5+) names. */
function toolState(inv: ToolInvocation): DynamicToolUIPart['state'] {
  switch (inv.state) {
    case 'partial-call':
      return 'input-streaming';
    case 'call':
      return 'input-available';
    case 'result':
      return inv.isError ? 'output-error' : 'output-available';
    default:
      return inv.state as DynamicToolUIPart['state'];
  }
}

function ChatMessage({ message }: { message: MastraDBMessage }) {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const parts = message.content.parts ?? [];
  return (
    <Message from={message.role}>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text) {
          return (
            <MessageContent key={i}>
              {message.role === 'assistant' ? <MessageResponse>{part.text}</MessageResponse> : part.text}
            </MessageContent>
          );
        }
        if (part.type === 'tool-invocation') {
          const inv = part.toolInvocation;
          const state = toolState(inv);
          return (
            <Tool key={inv.toolCallId} defaultOpen={state === 'output-error'}>
              <ToolHeader type="dynamic-tool" toolName={inv.toolName} state={state} />
              <ToolContent>
                <ToolInput input={inv.args} />
                <ToolOutput output={inv.result as DynamicToolUIPart['output']} errorText={inv.errorText} />
              </ToolContent>
            </Tool>
          );
        }
        return null;
      })}
    </Message>
  );
}

/** Runs one async action at a time and keeps its error to show. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function SupportChat() {
  const { messages, sendMessage, isRunning, cancelRun } = useChat(api.agents.supportAgent);
  const { error, run } = useAction();

  const last = messages.at(-1);
  const answering = last?.role === 'assistant' && (last.content.parts?.length ?? 0) > 0;
  const status: ChatStatus = error ? 'error' : isRunning ? (answering ? 'streaming' : 'submitted') : 'ready';

  const send = (text: string) => {
    if (text.trim() && !isRunning) void run(() => sendMessage(text));
  };

  return (
    <Card className="flex min-h-0 flex-col gap-0 py-0">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent data-testid="conversation">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<BotIcon className="size-8" />}
              title="Ask supportAgent"
              description="It's deployed from support-team and answers through the platform."
            />
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
          {status === 'submitted' && <Shimmer className="text-sm">Thinking…</Shimmer>}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="flex flex-col gap-3 border-t p-4">
        {messages.length === 0 && (
          <Suggestions>
            {SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={send} />
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={(m) => send(m.text ?? '')}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask about an order…" aria-label="Message" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="px-2 text-muted-foreground text-xs">supportAgent · prod</span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={cancelRun} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </Card>
  );
}

function Triage() {
  const [text, setText] = useState('I was charged twice for order A-17, please refund asap');
  const [result, setResult] = useState<TriageWorkflowOutput>();
  const { busy, error, run } = useAction();

  const triage = () =>
    run(async () => {
      setResult(undefined);
      const r = await api.workflows.triageWorkflow.start({ ticketId: 'T-7', text });
      if (r.status !== 'success') throw new Error(`run ended: ${r.status}`);
      setResult(r.result);
    });

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Triage a ticket</CardTitle>
        <CardDescription>ops-team's triageWorkflow runs support-team's classifyTicket step, then supportAgent drafts a reply.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Ticket text" />
        <Button disabled={busy} onClick={triage}>
          {busy ? 'Triaging…' : 'Triage'}
        </Button>
        {result && (
          <div className="flex flex-col gap-2 text-sm" data-testid="triage-result">
            <div className="flex gap-2">
              <Badge variant="secondary">{result.queue}</Badge>
              <Badge variant={result.priority === 'high' ? 'destructive' : 'outline'}>{result.priority}</Badge>
            </div>
            <p>{result.reply}</p>
          </div>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}

function Escalate() {
  const [ticketId, setTicketId] = useState('T-100');
  const [runId, setRunId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [result, setResult] = useState<EscalateWorkflowOutput>();
  const { busy, error, run } = useAction();

  const escalate = () =>
    run(async () => {
      setResult(undefined);
      const r = await api.workflows.escalateWorkflow.createRun();
      setRunId(r.runId);
      const out = await r.start({ ticketId, reason: 'refund over limit' });
      setStatus(out.status);
    });

  const approve = () =>
    run(async () => {
      const r = await api.workflows.escalateWorkflow.createRun(runId);
      const out = await r.resume('approve', { approved: true, assignee: 'sam' });
      setStatus(out.status);
      setResult(out.result);
    });

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Escalate a ticket</CardTitle>
        <CardDescription>Starts escalateWorkflow, which suspends until someone approves.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), escalate())}>
          <Input value={ticketId} onChange={(e) => setTicketId(e.target.value)} aria-label="Ticket id" />
          <Button disabled={busy}>Escalate</Button>
        </form>
        {runId && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              run <code className="font-mono">{runId.slice(0, 8)}</code>
            </span>
            <Badge variant={status === 'success' ? 'default' : 'secondary'}>{status ?? 'starting'}</Badge>
          </div>
        )}
        {result && <p className="text-sm">{result.note}</p>}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
      {status === 'suspended' && (
        <CardFooter>
          <Button variant="outline" disabled={busy} onClick={approve}>
            Approve, assign to sam
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function App() {
  return (
    <MastraReactProvider baseUrl={baseUrl} credentials="omit">
      <TooltipProvider>
        <div className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 p-4 md:p-6">
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="font-semibold text-lg">Support desk</h1>
            <span className="text-muted-foreground text-sm">units on {new URL(baseUrl).host}</span>
          </header>
          <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1fr_320px]">
            <SupportChat />
            <div className="flex min-h-0 flex-col gap-4 md:overflow-y-auto">
              <Triage />
              <Escalate />
            </div>
          </div>
        </div>
      </TooltipProvider>
    </MastraReactProvider>
  );
}
