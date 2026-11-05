// realtime-modules/src/client/useDocumentHidden.ts
//
// Whether the page is in the background, kept current (0.145.0: shared by
// usePipelineRunStatus and useLiveRefresh, which both pause polling on it).

import { useEffect, useState } from 'react';

/** True while the document is hidden (`document.hidden`). Always false outside a browser. */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

/** Whether the document is hidden, re-rendering on `visibilitychange`. Always false outside a browser. */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(isDocumentHidden);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const update = () => setHidden(isDocumentHidden());
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}
