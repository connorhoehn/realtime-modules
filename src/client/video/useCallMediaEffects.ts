import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMediaEffects, type MediaEffectsController } from '../media-effects/useMediaEffects';

// The pre-join preview and the native publisher own separate streams/engines,
// but share the person's effects choice. Never hand a preview track to a call.
type Change = { kind: 'filter'; value: string } | { kind: 'background'; value: 'none' | 'blur' | 'image' }
  | { kind: 'image' | 'face'; value: string | null };
const listeners = new Set<(change: Change) => void>();
export const CALL_MEDIA_EFFECTS_KEY = 'call-media-effects.v1';

export function useCallMediaEffects(): MediaEffectsController {
  const effects = useMediaEffects({ persistKey: CALL_MEDIA_EFFECTS_KEY });
  const current = useRef(effects);
  current.current = effects;
  const receive = useCallback((change: Change) => {
    const e = current.current;
    if (change.kind === 'filter') e.setFilter(change.value);
    else if (change.kind === 'background') e.setBackgroundMode(change.value);
    else if (change.kind === 'image') e.setBackgroundImageUrl(change.value);
    else e.setFaceSpriteId(change.value);
  }, []);
  useEffect(() => { listeners.add(receive); return () => { listeners.delete(receive); }; }, [receive]);
  const change = useCallback((next: Change) => {
    receive(next);
    for (const listener of listeners) if (listener !== receive) listener(next);
  }, [receive]);
  const controls = useMemo(() => ({
    setFilter: (value: string) => change({ kind: 'filter', value }),
    setBackgroundMode: (value: 'none' | 'blur' | 'image') => change({ kind: 'background', value }),
    setBackgroundImageUrl: (value: string | null) => change({ kind: 'image', value }),
    setFaceSpriteId: (value: string | null) => change({ kind: 'face', value }),
  }), [change]);
  return { ...effects, ...controls };
}
