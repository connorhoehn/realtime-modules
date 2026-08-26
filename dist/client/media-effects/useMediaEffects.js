"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMediaEffects = useMediaEffects;
const react_1 = require("react");
const presets_1 = require("./presets");
const faceSprites_1 = require("./faceSprites");
const backgrounds_1 = require("./backgrounds");
const assets_1 = require("./assets");
const engine_1 = require("./engine");
const persistence_1 = require("./persistence");
function localStorageOrNull() {
    // Guarded: SSR has no window, and some privacy modes throw on access.
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    }
    catch {
        return null;
    }
}
function derivePreviewSource(source) {
    // A cloned track shares the underlying camera source, so this does not
    // open a second device — but it does give the preview engine a track whose
    // lifetime we control independently of the published one.
    const clone = typeof source.clone === 'function' ? source.clone() : null;
    return clone ? { track: clone, owned: true } : { track: source, owned: false };
}
function useMediaEffects(opts) {
    const persistKey = opts?.persistKey;
    // Built-ins are memoized module-side; useMemo keeps array identity stable
    // when the caller passes a literal each render.
    const backgrounds = (0, react_1.useMemo)(() => opts?.backgrounds ?? (0, backgrounds_1.getBuiltInBackgrounds)(), 
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts?.backgrounds]);
    // Apply asset overrides exactly once, before any engine/model work.
    const assetsApplied = (0, react_1.useRef)(false);
    if (!assetsApplied.current) {
        assetsApplied.current = true;
        if (opts?.assets)
            (0, assets_1.setMediaEffectsAssets)(opts.assets);
    }
    const [settings, setSettings] = (0, react_1.useState)(() => {
        const restored = persistKey
            ? (0, persistence_1.readPersistedSettings)(localStorageOrNull(), persistKey, backgrounds)
            : null;
        return restored ?? persistence_1.DEFAULT_EFFECTS_SETTINGS;
    });
    const [outputTrack, setOutputTrack] = (0, react_1.useState)(null);
    const [draft, setDraft] = (0, react_1.useState)(null);
    const [previewEngineTrack, setPreviewEngineTrack] = (0, react_1.useState)(null);
    // settingsRef mirrors state synchronously so the lazily-created engine
    // picks up setter calls made in the same tick (before React re-renders).
    const settingsRef = (0, react_1.useRef)(settings);
    const draftRef = (0, react_1.useRef)(null);
    const engineRef = (0, react_1.useRef)(null);
    const unsubscribeRef = (0, react_1.useRef)(null);
    const previewEngineRef = (0, react_1.useRef)(null);
    const previewUnsubRef = (0, react_1.useRef)(null);
    const previewSourceRef = (0, react_1.useRef)(null);
    // The LIVE track a session is watching for 'ended'. The clone is
    // independent, so a dead camera reaches us only through the original.
    const sessionSourceRef = (0, react_1.useRef)(null);
    // Factory ref, not a dep: swapping factories mid-mount would be
    // meaningless (engines are already built) and would churn every callback.
    const createEngineRef = (0, react_1.useRef)(opts?.createEngine);
    createEngineRef.current = opts?.createEngine;
    const newEngine = (0, react_1.useCallback)(() => createEngineRef.current?.() ?? new engine_1.MediaEffectsEngine(), []);
    const seedEngine = (0, react_1.useCallback)((engine, s) => {
        engine.setFilter(s.filterId);
        engine.setBackgroundMode(s.backgroundMode);
        engine.setBackgroundImageUrl(s.backgroundImageUrl);
        engine.setFaceSpriteId(s.faceSpriteId);
    }, []);
    const getEngine = (0, react_1.useCallback)(() => {
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
    const cancelOnSourceEndedRef = (0, react_1.useRef)(() => { });
    const sessionSourceEnded = (0, react_1.useRef)(() => { cancelOnSourceEndedRef.current(); });
    /** Non-React teardown — safe to call from an unmount cleanup. */
    const disposePreviewResources = (0, react_1.useCallback)(() => {
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
            try {
                src.track.stop();
            }
            catch { /* already stopped */ }
        }
    }, []);
    const endPreviewSession = (0, react_1.useCallback)(() => {
        draftRef.current = null;
        disposePreviewResources();
        setDraft(null);
        setPreviewEngineTrack(null);
    }, [disposePreviewResources]);
    // The camera died. A draft over a dead source can't be judged and its
    // clone will never produce another frame — drop the session rather than
    // leave a frozen self-view and a leaked pipeline.
    cancelOnSourceEndedRef.current = () => {
        if (draftRef.current)
            endPreviewSession();
    };
    const watchSessionSource = (0, react_1.useCallback)(() => {
        const next = engineRef.current?.getSource() ?? null;
        const prev = sessionSourceRef.current;
        if (prev === next)
            return;
        prev?.removeEventListener?.('ended', sessionSourceEnded.current);
        sessionSourceRef.current = next;
        next?.addEventListener?.('ended', sessionSourceEnded.current);
    }, []);
    /** Build the second engine on the first divergent draft. Returns null when
     *  there is no source to clone (no camera attached yet). */
    const createPreviewEngine = (0, react_1.useCallback)(() => {
        const source = engineRef.current?.getSource() ?? null;
        if (!source)
            return null;
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
    const syncPreview = (0, react_1.useCallback)(() => {
        const d = draftRef.current;
        if (!d)
            return;
        let engine = previewEngineRef.current;
        if (!engine) {
            // Still mirroring live: previewTrack is the live output, and building
            // a second pipeline would be pure waste.
            if ((0, persistence_1.mediaEffectsSettingsEqual)(d, settingsRef.current))
                return;
            engine = createPreviewEngine();
            if (!engine)
                return; // seeded from the draft on creation; nothing to push
        }
        seedEngine(engine, d);
    }, [createPreviewEngine, seedEngine]);
    // ------------------------------------------------------------------ setters
    /** Route a patch to the draft while a session is open, to live otherwise.
     *  Returns true when the write went to the draft. */
    const update = (0, react_1.useCallback)((patch) => {
        if (draftRef.current) {
            draftRef.current = { ...draftRef.current, ...patch };
            setDraft(draftRef.current);
            return true;
        }
        settingsRef.current = { ...settingsRef.current, ...patch };
        setSettings(settingsRef.current);
        return false;
    }, []);
    const setFilter = (0, react_1.useCallback)((id) => {
        if (update({ filterId: id }))
            return syncPreview();
        engineRef.current?.setFilter(id);
    }, [update, syncPreview]);
    const setBackgroundMode = (0, react_1.useCallback)((mode) => {
        if (update({ backgroundMode: mode }))
            return syncPreview();
        engineRef.current?.setBackgroundMode(mode);
    }, [update, syncPreview]);
    const setBackgroundImageUrl = (0, react_1.useCallback)((url) => {
        if (update({ backgroundImageUrl: url }))
            return syncPreview();
        engineRef.current?.setBackgroundImageUrl(url);
    }, [update, syncPreview]);
    const setFaceSpriteId = (0, react_1.useCallback)((id) => {
        if (update({ faceSpriteId: id }))
            return syncPreview();
        engineRef.current?.setFaceSpriteId(id);
    }, [update, syncPreview]);
    // ------------------------------------------------------------ session verbs
    const beginPreview = (0, react_1.useCallback)(() => {
        if (draftRef.current)
            return; // already open — never clobber a live draft
        draftRef.current = { ...settingsRef.current };
        setDraft(draftRef.current);
        watchSessionSource();
    }, [watchSessionSource]);
    const applyPreview = (0, react_1.useCallback)(() => {
        const d = draftRef.current;
        if (!d)
            return;
        settingsRef.current = d;
        setSettings(d);
        // The one moment the live engine hears about a draft. Already-active →
        // still-active means field writes only: same outputTrack, no rebuild.
        // (When no engine exists yet these settings are seeded at attach time.)
        if (engineRef.current)
            seedEngine(engineRef.current, d);
        endPreviewSession();
    }, [seedEngine, endPreviewSession]);
    const cancelPreview = (0, react_1.useCallback)(() => {
        if (!draftRef.current)
            return;
        endPreviewSession();
    }, [endPreviewSession]);
    // ----------------------------------------------------------------- lifecycle
    const warmup = (0, react_1.useCallback)((target = 'all') => {
        // Engine.warmup delegates to module-level loaders, so this works
        // before any source attaches or pipeline exists.
        getEngine().warmup(target);
    }, [getEngine]);
    const attach = (0, react_1.useCallback)((track) => {
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
                    try {
                        staleSource.track.stop();
                    }
                    catch { /* already stopped */ }
                }
            }
            // Covers both the rebuild above and the case where the draft diverged
            // before any camera existed (nothing to clone at the time).
            syncPreview();
            watchSessionSource();
        }
        return engine.getOutputTrack() ?? track;
    }, [getEngine, syncPreview, watchSessionSource]);
    const processStream = (0, react_1.useCallback)((raw) => {
        const tracks = [...raw.getAudioTracks()];
        const video = raw.getVideoTracks()[0];
        if (video)
            tracks.push(attach(video));
        return new MediaStream(tracks);
    }, [attach]);
    const detach = (0, react_1.useCallback)(() => {
        if (draftRef.current)
            endPreviewSession();
        engineRef.current?.setSource(null);
    }, [endPreviewSession]);
    // Persist on change (after restore, which happens in the state initializer).
    // Keyed on `settings` — the COMMITTED state — so a draft is invisible to
    // storage until applyPreview() folds it in.
    (0, react_1.useEffect)(() => {
        if (!persistKey)
            return;
        (0, persistence_1.writePersistedSettings)(localStorageOrNull(), persistKey, settings);
    }, [persistKey, settings]);
    // Dispose on unmount — engine never stops the caller's source track, but
    // the preview clone is ours and must be stopped even mid-session.
    (0, react_1.useEffect)(() => {
        return () => {
            disposePreviewResources();
            draftRef.current = null;
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            engineRef.current?.dispose();
            engineRef.current = null;
        };
    }, [disposePreviewResources]);
    const active = settings.filterId !== 'none' ||
        settings.backgroundMode !== 'none' ||
        settings.faceSpriteId != null;
    const isDirty = draft != null && !(0, persistence_1.mediaEffectsSettingsEqual)(draft, settings);
    // Until the draft diverges there is no second engine, and the truest
    // self-view of "what the draft looks like" is the live output itself.
    const previewTrack = draft == null ? null : previewEngineTrack ?? outputTrack;
    return (0, react_1.useMemo)(() => ({
        filterId: settings.filterId,
        backgroundMode: settings.backgroundMode,
        backgroundImageUrl: settings.backgroundImageUrl,
        faceSpriteId: settings.faceSpriteId,
        active,
        outputTrack,
        filters: presets_1.FILTER_PRESETS,
        backgrounds,
        faceSprites: faceSprites_1.FACE_SPRITES,
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
//# sourceMappingURL=useMediaEffects.js.map