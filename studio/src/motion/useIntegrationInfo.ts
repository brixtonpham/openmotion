import { useEffect, useState } from 'react';
import { isIntegrationInfo, type IntegrationInfo } from '../../../shared/integration';

export function useIntegrationInfo() {
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setInfo(null);
    setFailed(false);
    void (async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      for (const endpoint of ['/motion-api/account/integration', '/motion-api/integration']) {
        try {
          const response = await fetch(endpoint, { signal });
          if (!response.ok) continue;
          const value = await response.json() as IntegrationInfo;
          if (!isIntegrationInfo(value)) continue;
          if (!controller.signal.aborted) setInfo(value);
          return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) setFailed(true);
    })();
    return () => controller.abort();
  }, [attempt]);
  return { info, failed, retry: () => retry(value => value + 1) };
}
