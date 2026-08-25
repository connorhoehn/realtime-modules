// realtime-modules/src/client/media-effects/useMediaEffects.ts
//
// React hook wrapping a single MediaEffectsEngine instance.
//
// Why a thin wrapper: all effect mechanics (lazy pipeline, output identity,
// teardown) live in the engine so they're unit-testable without React; the
// hook only adds React-shaped concerns — state for re-render, stable
// callbacks, localStorage persistence, and lifecycle (dispose on unmount).
//
// Track identity contract (inherited from the engine): outputTrack only
// changes on activation / deactivation / attach / detach — flipping presets
// while active never churns the track, so callers can hand outputTrack to
// RTCRtpSender.replaceTrack without debouncing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILTER_PRESETS, type FilterPreset } from './presets';
import { FACE_SPRITES, type FaceSprite } from './faceSprites';
import { getBuiltInBackgrounds, type BackgroundOption } from './backgrounds';
import { setMediaEffectsAssets, type MediaEffectsAssets } from './assets';
import { MediaEffectsEngine, type BackgroundMode, type WarmupTarget } from './engine';
import {
  DEFAULT_EFFECTS_SETTINGS,
  readPersistedSettings,
  writePersistedSettings,
  type PersistedEffectsSettings,
} from './persistence';

export interface UseMediaEffectsOptions {
  /** Self-hosted MediaPipe asset URLs; applied before any model load. */
  assets?: MediaEffectsAssets;
  /** Background tray; defaults to the built-in generated gradients. */
  backgrounds?: BackgroundOption[];
  /** localStorage key — settings restore on mount and persist on change. */
  persistKey?: string;
}

export interface MediaEffectsController {
  filterId: string;
  backgroundMode: BackgroundMode;
  backgroundImageUrl: string | null;
  faceSpriteId: string | null;
  active: boolean;
  /** Current output — identity-stable per the engine contract. */
  outputTrack: MediaStreamTrack | null;
  /** Registries, exposed for rendering selection trays. */
  filters: FilterPreset[];
  backgrounds: BackgroundOption[];
  faceSprites: FaceSprite[];
  setFilter(id: string): void;
  setBackgroundMode(mode: BackgroundMode): void;
  setBackgroundImageUrl(url: string | null): void;
  setFaceSpriteId(id: string | null): void;
  /**
   * Preload MediaPipe models (fire-and-forget) — call when the effects UI
   * opens so the first selection doesn't freeze on model init. Safe to
   * call repeatedly; SSR-safe no-op. Default target: 'all'.
   */
  warmup(target?: WarmupTarget): void;
  /** setSource + return current output (=== input while inactive). */
  attach(track: MediaStreamTrack): MediaStreamTrack;
  /** New stream: audio tracks pass through, video track replaced via attach(). */
  processStream(raw: MediaStream): MediaStream;
  /** Dispose the pipeline and forget the source (source is never stopped). */
  detach(): void;
}

function localStorageOrNull(): Storage | null {
  // Guarded: SSR has no window, and some privacy modes throw on access.
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function useMediaEffects(opts?: UseMediaEffectsOptions): MediaEffectsController {
  const persistKey = opts?.persistKey;

  // Built-ins are memoized module-side; useMemo keeps array identity stable
  // when the caller passes a literal each render.
  const backgrounds = useMemo(
    () => opts?.backgrounds ?? getBuiltInBackgrounds(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts?.backgrounds],
  );

  // Apply asset overrides exactly once, before any engine/model work.
  const assetsApplied = useRef(false);
  if (!assetsApplied.current) {
    assetsApplied.current = true;
    if (opts?.assets) setMediaEffectsAssets(opts.assets);
  }

  const [settings, setSettings] = useState<PersistedEffectsSettings>(() => {
    const restored = persistKey
      ? readPersistedSettings(localStorageOrNull(), persistKey, backgrounds)
      : null;
    return restored ?? DEFAULT_EFFECTS_SETTINGS;
  });
  const [outputTrack, setOutputTrack] = useState<MediaStreamTrack | null>(null);

  // settingsRef mirrors state synchronously so the lazily-created engine
  // picks up setter calls made in the same tick (before React re-renders).
  const settingsRef = useRef(settings);
  const engineRef = useRef<MediaEffectsEngine | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const getEngine = useCallback((): MediaEffectsEngine => {
    if (!engineRef.current) {
      const engine = new MediaEffectsEngine();
      const s = settingsRef.current;
      // Seed restored/preset settings BEFORE any source attaches, so the
      // pipeline builds at most once, on attach.
      engine.setFilter(s.filterId);
      engine.setBackgroundMode(s.backgroundMode);
      engine.setBackgroundImageUrl(s.backgroundImageUrl);
      engine.setFaceSpriteId(s.faceSpriteId);
      unsubscribeRef.current = engine.onOutputChange((track) => setOutputTrack(track));
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const update = useCallback((patch: Partial<PersistedEffectsSettings>) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings(settingsRef.current);
  }, []);

  const setFilter = useCallback((id: string) => {
    update({ filterId: id });
    engineRef.current?.setFilter(id);
  }, [update]);

  const setBackgroundMode = useCallback((mode: BackgroundMode) => {
    update({ backgroundMode: mode });
    engineRef.current?.setBackgroundMode(mode);
  }, [update]);

  const setBackgroundImageUrl = useCallback((url: string | null) => {
    update({ backgroundImageUrl: url });
    engineRef.current?.setBackgroundImageUrl(url);
  }, [update]);

  const setFaceSpriteId = useCallback((id: string | null) => {
    update({ faceSpriteId: id });
    engineRef.current?.setFaceSpriteId(id);
  }, [update]);

  const warmup = useCallback((target: WarmupTarget = 'all') => {
    // Engine.warmup delegates to module-level loaders, so this works
    // before any source attaches or pipeline exists.
    getEngine().warmup(target);
  }, [getEngine]);

  const attach = useCallback((track: MediaStreamTrack): MediaStreamTrack => {
    const engine = getEngine();
    engine.setSource(track);
    return engine.getOutputTrack() ?? track;
  }, [getEngine]);

  const processStream = useCallback((raw: MediaStream): MediaStream => {
    const tracks: MediaStreamTrack[] = [...raw.getAudioTracks()];
    const video = raw.getVideoTracks()[0];
    if (video) tracks.push(attach(video));
    return new MediaStream(tracks);
  }, [attach]);

  const detach = useCallback(() => {
    engineRef.current?.setSource(null);
  }, []);

  // Persist on change (after restore, which happens in the state initializer).
  useEffect(() => {
    if (!persistKey) return;
    writePersistedSettings(localStorageOrNull(), persistKey, settings);
  }, [persistKey, settings]);

  // Dispose on unmount — engine never stops the caller's source track.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const active =
    settings.filterId !== 'none' ||
    settings.backgroundMode !== 'none' ||
    settings.faceSpriteId != null;

  return useMemo<MediaEffectsController>(() => ({
    filterId: settings.filterId,
    backgroundMode: settings.backgroundMode,
    backgroundImageUrl: settings.backgroundImageUrl,
    faceSpriteId: settings.faceSpriteId,
    active,
    outputTrack,
    filters: FILTER_PRESETS,
    backgrounds,
    faceSprites: FACE_SPRITES,
    setFilter,
    setBackgroundMode,
    setBackgroundImageUrl,
    setFaceSpriteId,
    warmup,
    attach,
    processStream,
    detach,
  }), [
    settings, active, outputTrack, backgrounds,
    setFilter, setBackgroundMode, setBackgroundImageUrl, setFaceSpriteId,
    warmup, attach, processStream, detach,
  ]);
}
