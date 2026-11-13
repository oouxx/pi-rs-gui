// Chat state lives in the Zustand store (`src/stores/chat.ts`). This module
// keeps the historical import path for components.
export { useChat, useChatSync, useChatStore } from "../stores/chat";
export type { SessionItem } from "../stores/chat";

// Re-export so components keep importing message shapes from the hook module.
export type { ContentBlock, DisplayMessage } from "./message-reducer";
