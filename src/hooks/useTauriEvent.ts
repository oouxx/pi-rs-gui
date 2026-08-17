import { useEffect } from "react";
import { tauriListen } from "../api/events";

/**
 * Generic hook for subscribing to Tauri events.
 * Automatically cleans up on unmount or when event/handler changes.
 */
export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    tauriListen<T>(event, handler).then((unsub) => {
      if (disposed) {
        unsub();
        return;
      }
      unlisten = unsub;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event, handler]);
}
