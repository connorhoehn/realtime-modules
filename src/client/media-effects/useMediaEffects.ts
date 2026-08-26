// realtime-modules/src/client/media-effects/useMediaEffects.ts
//
// React hook wrapping MediaEffectsEngine instances.
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
//
// ------------------------------------------------------------------ preview
//
// DRAFT / COMMITTED SPLIT. Without it, picking a silly face sprite mid-call
// mutates the published track immediately — everyone sees it before you can
// judge it. So the hook has two states:
//
//   committed (`settings`)  → drives the LIVE engine, whose outputTrack is
//                             what the caller publishes. Peers only ever see
//                             this change, and only via applyPreview().
//   draft (`draft`)         → non-null only while a preview session is open.
//                             While open, setFilter/setBackgroundMode/... write
//                             here and NOWHERE else; the live engine is not
//                             touched at all.
//
// When no session is open the code path is exactly what it was before the
// split (one `if (draftRef.current)` miss per setter), so consumers that never
// call beginPreview() are unaffected.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILTER_PRESETS, type FilterPreset } from './presets';
import { FACE_SPRITES, type FaceSprite } from './faceSprites';
import { getBuiltInBackgrounds, type BackgroundOption } from './backgrounds';
import { setMediaEffectsAssets, type MediaEffectsAssets } from './assets';
import { MediaEffectsEngine, type BackgroundMode, type WarmupTarget } from './engine';
import {
  DEFAULT_EFFECTS_SETTINGS,
  mediaEffectsSettingsEqual,
  readPersistedSettings,
  writePersistedSettings,
  type MediaEffectsSettings,
} from './persistence';

export type { MediaEffectsSettings } from './persistence';

export interface UseMediaEffectsOptions {
  /** Self-hosted MediaPipe asset URLs; applied before any model load. */
  assets?: MediaEffectsAssets;
  /** Background tray; defaults to the built-in generated gradients. */
  backgrounds?: BackgroundOption[];
  /**
   * localStorage key — settings restore on mount and persist on change.
   * Only COMMITTED settings are written: an abandoned preview never survives
   * a reload, because a draft is not persisted until applyPreview() folds it
   * into the committed state.
   */
  persistKey?: string;
  /**
   * Engine factory seam. Defaults to `new MediaEffectsEngine()`. Called at
   * most twice per mount (once for the live engine, once for the preview
   * engine). Exists so tests — and hosts with an engine subclass — can drive
   * the hook without canvas/MediaPipe.
   */
  createEngine?: () => MediaEffectsEngine;
}

export interface MediaEffectsController {
  filterId: string;
  backgroundMode: BackgroundMode;
  backgroundImageUrl: string | null;
  faceSpriteId: string | null;
  active: boolean;
  /** Current LIVE output — identity-stable per the engine contract. */
  outputTrack: MediaStreamTrack | null;
  /** Registries, exposed for rendering selection trays. */
  filters: FilterPreset[];
  backgrounds: BackgroundOption[];
  faceSprites: FaceSprite[];
  /**
   * Non-null only while a preview session is open. While it is non-null the
   * setters below write to the draft ONLY — the live output is untouched.
   */
  draft: MediaEffectsSettings | null;
  /** True when `draft` differs from what is live. */
  isDirty: boolean;
  /**
   * Self-view track rendering the DRAFT settings. Null when no session.
   * NEVER published — the live `outputTrack` is untouched until applyPreview().
   *
   * COST. A second segmentation pipeline is the most expensive thing this
   * module can do (canvas + RAF loop + MediaPipe per frame), so it is created
   * as late as possible and destroyed as early as possible:
   *
   *   - beginPreview() creates NOTHING. The draft still equals live, so this
   *     is literally the live `outputTrack` — the self-view already shows
   *     exactly what peers see. Opening and closing the panel without
   *     touching anything costs zero frames.
   *   - The first setter call that makes the draft DIFFER from live clones
   *     the live source track (a clone shares the camera — no second
   *     getUserMedia) and spins up a second engine on it. That engine is
   *     itself lazy: an all-effects-off draft still builds no pipeline.
   *   - The engine survives the rest of the session even if the draft
   *     wanders back to the live settings, so previewTrack identity churns
   *     at most once per session rather than thrashing on every toggle.
   *   - applyPreview() / cancelPreview() / unmount / source-ended /
   *     detach() all dispose it and stop the clone.
   *
   * So the peak cost is two pipelines, and only while a divergent draft is
   * open with effects on — which is precisely when the user is looking at
   * the panel deciding.
   *
   * Lifecycle is owned by the controller: render it into a <video> and drop
   * the reference, never stop() it. While the draft still matches live this
   * IS the live track, and stopping it would kill the published stream.
   */
  previewTrack: MediaStreamTrack | null;
  setFilter(id: string): void;
  setBackgroundMode(mode: BackgroundMode): void;
  setBackgroundImageUrl(url: string | null): void;
  setFaceSpriteId(id: string | null): void;
  /**
   * Open a preview session: snapshot live settings into `draft`. While a
   * session is open the existing setters write to `draft` ONLY. Calling it
   * again while a session is already open is a no-op — it must not discard
   * an in-progress draft.
   */
  beginPreview(): void;
  /**
   * Commit `draft` to live (this is the only thing peers ever see change),
   * then end the session. No-op when no session is open.
   *
   * The live output track identity survives the commit whenever the engine
   * was already active and stays active — the engine treats setting changes
   * as field reads in its draw loop, so there is no rebuild and no
   * replaceTrack churn. Committing a draft that switches effects entirely
   * off (or on, from nothing) still crosses the engine's activation edge and
   * swaps identity, exactly as the pre-preview setters always did.
   */
  applyPreview(): void;
  /** Discard `draft`, leave live untouched, end the session. No-op when no
   *  session is open. */
  cancelPreview(): void;
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
  /** Dispose the pipeline and forget the source (source is never stopped).
   *  Also cancels any open preview session — its clone is now orphaned. */
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

interface PreviewSource {
  track: MediaStreamTrack;
  /** True when we minted it via clone() and are therefore responsible for
   *  stopping it. False when clone() was unavailable and we're sharing the
   *  caller's track, which we must never stop. */
  owned: boolean;
}

function derivePreviewSource(source: MediaStreamTrack): PreviewSource {
  // A cloned track shares the underlying camera source, so this does not
  // open a second device — but it does give the preview engine a track whose
  // lifetime we control independently of the published one.
  const clone = typeof source.clone === 'function' ? source.clone() : null;
  return clone ? { track: clone, owned: true } : { track: source, owned: false };
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

  const [settings, setSettings] = useState<MediaEffectsSettings>(() => {
    const restored = persistKey
      ? readPersistedSettings(localStorageOrNull(), persistKey, backgrounds)
      : null;
    return restored ?? DEFAULT_EFFECTS_SETTINGS;
  });
  const [outputTrack, setOutputTrack] = useState<MediaStreamTrack | null>(null);
  const [draft, setDraft] = useState<MediaEffectsSettings | null>(null);
  const [previewEngineTrack, setPreviewEngineTrack] = useState<MediaStreamTrack | null>(null);

  // settingsRef mirrors state synchronously so the lazily-created engine
  // picks up setter calls made in the same tick (before React re-renders).
  const settingsRef = useRef(settings);
  const draftRef = useRef<MediaEffectsSettings | null>(null);
  const engineRef = useRef<MediaEffectsEngine | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const previewEngineRef = useRef<MediaEffectsEngine | null>(null);
  const previewUnsubRef = useRef<(() => void) | null>(null);
  const previewSourceRef = useRef<PreviewSource | null>(null);
  // The LIVE track a session is watching for 'ended'. The clone is
  // independent, so a dead camera reaches us only through the original.
  const sessionSourceRef = useRef<MediaStreamTrack | null>(null);

  // Factory ref, not a dep: swapping factories mid-mount would be
  // meaningless (engines are already built) and would churn every callback.
  const createEngineRef = useRef(opts?.createEngine);
  createEngineRef.current = opts?.createEngine;
  const newEngine = useCallback(
    (): MediaEffectsEngine => createEngineRef.current?.() ?? new MediaEffectsEngine(),
    [],
  );

  const seedEngine = useCallback((engine: MediaEffectsEngine, s: MediaEffectsSettings) => {
    engine.setFilter(s.filterId);
    engine.setBackgroundMode(s.backgroundMode);
    engine.setBackgroundImageUrl(s.backgroundImageUrl);
    engine.setFaceSpriteId(s.faceSpriteId);
  }, []);

  const getEngine = useCallback((): MediaEffectsEngine => {
    if (!engineRef.current) {
      const engine = newEngine();
      // Seed restored/preset settings BEFORE any source attaches, so the
      // pipeline builds at most once, on attach.
      seedEngine(engine, settingsRef.current);
      unsubscribeRef.current = engine.onOutputChange((track) => setOutputTrack(track));
      engineRef.current = engine;
    }
    return engineRef.current;
  }, [newEngine, seedEngine]);

  // ------------------------------------------------------------ preview plumbing

  // Stable listener identity so add/removeEventListener pair across attach()
  // calls; it defers to a ref because the handler it needs is defined below.
  const cancelOnSourceEndedRef = useRef<() => void>(() => {});
  const sessionSourceEnded = useRef(() => { cancelOnSourceEndedRef.current(); });

  /** Non-React teardown — safe to call from an unmount cleanup. */
  const disposePreviewResources = useCallback(() => {
    sessionSourceRef.current?.removeEventListener?.('ended', sessionSourceEnded.current);
    sessionSourceRef.current = null;
    previewUnsubRef.current?.();
    previewUnsubRef.current = null;
    previewEngineRef.current?.dispose();
    previewEngineRef.current = null;
    const src = previewSourceRef.current;
    previewSourceRef.current = null;
    // Only ever stop a track we minted. The engine itself never stops its
    // source, so this is the one place the clone can be released.
    if (src?.owned) {
      try { src.track.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const endPreviewSession = useCallback(() => {
    draftRef.current = null;
    disposePreviewResources();
    setDraft(null);
    setPreviewEngineTrack(null);
  }, [disposePreviewResources]);

  // The camera died. A draft over a dead source can't be judged and its
  // clone will never produce another frame — drop the session rather than
  // leave a frozen self-view and a leaked pipeline.
  cancelOnSourceEndedRef.current = () => {
    if (draftRef.current) endPreviewSession();
  };

  const watchSessionSource = useCallback(() => {
    const next = engineRef.current?.getSource() ?? null;
    const prev = sessionSourceRef.current;
    if (prev === next) return;
    prev?.removeEventListener?.('ended', sessionSourceEnded.current);
    sessionSourceRef.current = next;
    next?.addEventListener?.('ended', sessionSourceEnded.current);
  }, []);

  /** Build the second engine on the first divergent draft. Returns null when
   *  there is no source to clone (no camera attached yet). */
  const createPreviewEngine = useCallback((): MediaEffectsEngine | null => {
    const source = engineRef.current?.getSource() ?? null;
    if (!source) return null;
    const engine = newEngine();
    const previewSource = derivePreviewSource(source);
    previewSourceRef.current = previewSource;
    // Seed BEFORE setSource so the pipeline builds at most once.
    seedEngine(engine, draftRef.current ?? settingsRef.current);
    previewUnsubRef.current = engine.onOutputChange((t) => setPreviewEngineTrack(t));
    previewEngineRef.current = engine;
    engine.setSource(previewSource.track);
    setPreviewEngineTrack(engine.getOutputTrack());
    return engine;
  }, [newEngine, seedEngine]);

  /** Push the current draft at the preview engine, creating it if the draft
   *  has just diverged from live. No-op outside a session. */
  const syncPreview = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    let engine = previewEngineRef.current;
    if (!engine) {
      // Still mirroring live: previewTrack is the live output, and building
      // a second pipeline would be pure waste.
      if (mediaEffectsSettingsEqual(d, settingsRef.current)) return;
      engine = createPreviewEngine();
      if (!engine) return; // seeded from the draft on creation; nothing to push
    }
    seedEngine(engine, d);
  }, [createPreviewEngine, seedEngine]);

  // ------------------------------------------------------------------ setters

  /** Route a patch to the draft while a session is open, to live otherwise.
   *  Returns true when the write went to the draft. */
  const update = useCallback((patch: Partial<MediaEffectsSettings>): boolean => {
    if (draftRef.current) {
      draftRef.current = { ...draftRef.current, ...patch };
      setDraft(draftRef.current);
      return true;
    }
    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings(settingsRef.current);
    return false;
  }, []);

  const setFilter = useCallback((id: string) => {
    if (update({ filterId: id })) return syncPreview();
    engineRef.current?.setFilter(id);
  }, [update, syncPreview]);

  const setBackgroundMode = useCallback((mode: BackgroundMode) => {
    if (update({ backgroundMode: mode })) return syncPreview();
    engineRef.current?.setBackgroundMode(mode);
  }, [update, syncPreview]);

  const setBackgroundImageUrl = useCallback((url: string | null) => {
    if (update({ backgroundImageUrl: url })) return syncPreview();
    engineRef.current?.setBackgroundImageUrl(url);
  }, [update, syncPreview]);

  const setFaceSpriteId = useCallback((id: string | null) => {
    if (update({ faceSpriteId: id })) return syncPreview();
    engineRef.current?.setFaceSpriteId(id);
  }, [update, syncPreview]);

  // ------------------------------------------------------------ session verbs

  const beginPreview = useCallback(() => {
    if (draftRef.current) return; // already open — never clobber a live draft
    draftRef.current = { ...settingsRef.current };
    setDraft(draftRef.current);
    watchSessionSource();
  }, [watchSessionSource]);

  const applyPreview = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    settingsRef.current = d;
    setSettings(d);
    // The one moment the live engine hears about a draft. Already-active →
    // still-active means field writes only: same outputTrack, no rebuild.
    // (When no engine exists yet these settings are seeded at attach time.)
    if (engineRef.current) seedEngine(engineRef.current, d);
    endPreviewSession();
  }, [seedEngine, endPreviewSession]);

  const cancelPreview = useCallback(() => {
    if (!draftRef.current) return;
    endPreviewSession();
  }, [endPreviewSession]);

  // ----------------------------------------------------------------- lifecycle

  const warmup = useCallback((target: WarmupTarget = 'all') => {
    // Engine.warmup delegates to module-level loaders, so this works
    // before any source attaches or pipeline exists.
    getEngine().warmup(target);
  }, [getEngine]);

  const attach = useCallback((track: MediaStreamTrack): MediaStreamTrack => {
    const engine = getEngine();
    engine.setSource(track);
    if (draftRef.current) {
      // Camera swapped mid-session. A pipeline is bound to its source, so the
      // preview has to be rebuilt on a clone of the new track rather than
      // re-pointed; then re-arm the 'ended' watch on the new original.
      if (previewEngineRef.current) {
        const stale = previewEngineRef.current;
        previewUnsubRef.current?.();
        previewUnsubRef.current = null;
        previewEngineRef.current = null;
        stale.dispose();
        const staleSource = previewSourceRef.current;
        previewSourceRef.current = null;
        if (staleSource?.owned) {
          try { staleSource.track.stop(); } catch { /* already stopped */ }
        }
      }
      // Covers both the rebuild above and the case where the draft diverged
      // before any camera existed (nothing to clone at the time).
      syncPreview();
      watchSessionSource();
    }
    return engine.getOutputTrack() ?? track;
  }, [getEngine, syncPreview, watchSessionSource]);

  const processStream = useCallback((raw: MediaStream): MediaStream => {
    const tracks: MediaStreamTrack[] = [...raw.getAudioTracks()];
    const video = raw.getVideoTracks()[0];
    if (video) tracks.push(attach(video));
    return new MediaStream(tracks);
  }, [attach]);

  const detach = useCallback(() => {
    if (draftRef.current) endPreviewSession();
    engineRef.current?.setSource(null);
  }, [endPreviewSession]);

  // Persist on change (after restore, which happens in the state initializer).
  // Keyed on `settings` — the COMMITTED state — so a draft is invisible to
  // storage until applyPreview() folds it in.
  useEffect(() => {
    if (!persistKey) return;
    writePersistedSettings(localStorageOrNull(), persistKey, settings);
  }, [persistKey, settings]);

  // Dispose on unmount — engine never stops the caller's source track, but
  // the preview clone is ours and must be stopped even mid-session.
  useEffect(() => {
    return () => {
      disposePreviewResources();
      draftRef.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [disposePreviewResources]);

  const active =
    settings.filterId !== 'none' ||
    settings.backgroundMode !== 'none' ||
    settings.faceSpriteId != null;

  const isDirty = draft != null && !mediaEffectsSettingsEqual(draft, settings);

  // Until the draft diverges there is no second engine, and the truest
  // self-view of "what the draft looks like" is the live output itself.
  const previewTrack = draft == null ? null : previewEngineTrack ?? outputTrack;

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
    draft,
    isDirty,
    previewTrack,
    setFilter,
    setBackgroundMode,
    setBackgroundImageUrl,
    setFaceSpriteId,
    beginPreview,
    applyPreview,
    cancelPreview,
    warmup,
    attach,
    processStream,
    detach,
  }), [
    settings, active, outputTrack, backgrounds, draft, isDirty, previewTrack,
    setFilter, setBackgroundMode, setBackgroundImageUrl, setFaceSpriteId,
    beginPreview, applyPreview, cancelPreview,
    warmup, attach, processStream, detach,
  ]);
}
