import { createContext, useContext, type ReactNode } from "react";
import { useChat, useChatSync } from "./useChat";

export type ChatApi = ReturnType<typeof useChat>;

const ChatContext = createContext<ChatApi | null>(null);

/**
 * Mounts the Tauri event bridge exactly once and exposes the shared Zustand
 * chat state to the sidebar and the chat pane.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  useChatSync();
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
