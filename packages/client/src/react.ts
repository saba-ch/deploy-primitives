// React hooks for the `api` that `mastra-platform pull --target web` writes. Wrap the app in
// @mastra/react's <MastraReactProvider baseUrl={baseUrl}> (baseUrl comes from the same file).
import { useChat as useMastraChat } from '@mastra/react';
import { useCallback, useState } from 'react';
import type { TypedAgent } from './web';

export type ChatOptions = {
  /** Memory thread. Defaults to a new one per mounted chat. */
  threadId?: string;
  resourceId?: string;
};

/** @mastra/react's useChat for an agent from the generated api: `useChat(api.agents.supportAgent)`. */
export function useChat(agent: TypedAgent, { threadId: fixed, resourceId }: ChatOptions = {}) {
  const [fresh] = useState(() => crypto.randomUUID());
  const threadId = fixed ?? fresh;
  const chat = useMastraChat({ agentId: agent.target, resourceId });
  const { sendMessage: send } = chat;
  const sendMessage = useCallback((message: string) => send({ message, mode: 'stream', threadId }), [send, threadId]);
  return { ...chat, sendMessage, threadId };
}
