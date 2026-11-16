import { useEffect, useRef, useState } from "react";

const MAX_WAIT_MS = 2000;
const COST_FACTOR = 2;

export function useThrottledText(content: string, enabled: boolean): string {
  const startedAtRef = useRef(performance.now());
  const allowedAtRef = useRef(0);
  const [output, setOutput] = useState(content);

  useEffect(() => {
    const now = performance.now();
    allowedAtRef.current =
      now + Math.min(MAX_WAIT_MS, (now - startedAtRef.current) * COST_FACTOR);
  }, [output]);

  useEffect(() => {
    if (!enabled) return;
    const commit = () => {
      startedAtRef.current = performance.now();
      setOutput(content);
    };
    const delay = allowedAtRef.current - performance.now();
    if (delay <= 0) {
      commit();
      return;
    }
    const timer = setTimeout(commit, delay);
    return () => clearTimeout(timer);
  }, [content, enabled]);

  return enabled ? output : content;
}
