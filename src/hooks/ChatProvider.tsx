import { createContext, useContext, type ReactNode } from "react";
import { useChat } from "./useChat";

export type ChatApi = ReturnType<typeof useChat>;

const ChatContext = createContext<ChatApi | null>(null);

/**
 * Hosts the single `useChat` instance shared by the sidebar and the chat pane.
 *
 * Calling `useChat()` in both places used to create two independent copies of
 * sessions/messages/streaming state, two sets of Tauri event listeners, and a
 * duplicate `get_state` + transcript fetch per event.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatApi {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within <ChatProvider>");
  }
  return ctx;
}
