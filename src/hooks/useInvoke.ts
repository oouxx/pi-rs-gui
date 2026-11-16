import { useCallback, useEffect, useRef, useState } from "react";

import { parseError } from "@/lib/errors";

/**
 * Generic hook for Tauri invoke calls with loading/error state.
 * Returns [data, error, loading, refetch].
 */
export function useInvoke<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): [T | null, Error | null, boolean, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const execute = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => { if (mountedRef.current) { setData(result); setLoading(false); } })
      .catch((err) => { if (mountedRef.current) { setError(new Error(parseError(err).message)); setLoading(false); } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    execute();
    return () => { mountedRef.current = false; };
  }, [execute]);

  return [data, error, loading, execute];
}
