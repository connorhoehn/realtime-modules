"use strict";
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
    // settingsRef mirrors state synchronously so the lazily-created engine
    // picks up setter calls made in the same tick (before React re-renders).
    const settingsRef = (0, react_1.useRef)(settings);
    const engineRef = (0, react_1.useRef)(null);
    const unsubscribeRef = (0, react_1.useRef)(null);
    const getEngine = (0, react_1.useCallback)(() => {
        if (!engineRef.current) {
            const engine = new engine_1.MediaEffectsEngine();
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
    const update = (0, react_1.useCallback)((patch) => {
        settingsRef.current = { ...settingsRef.current, ...patch };
        setSettings(settingsRef.current);
    }, []);
    const setFilter = (0, react_1.useCallback)((id) => {
        update({ filterId: id });
        engineRef.current?.setFilter(id);
    }, [update]);
    const setBackgroundMode = (0, react_1.useCallback)((mode) => {
        update({ backgroundMode: mode });
        engineRef.current?.setBackgroundMode(mode);
    }, [update]);
    const setBackgroundImageUrl = (0, react_1.useCallback)((url) => {
        update({ backgroundImageUrl: url });
        engineRef.current?.setBackgroundImageUrl(url);
    }, [update]);
    const setFaceSpriteId = (0, react_1.useCallback)((id) => {
        update({ faceSpriteId: id });
        engineRef.current?.setFaceSpriteId(id);
    }, [update]);
    const attach = (0, react_1.useCallback)((track) => {
        const engine = getEngine();
        engine.setSource(track);
        return engine.getOutputTrack() ?? track;
    }, [getEngine]);
    const processStream = (0, react_1.useCallback)((raw) => {
        const tracks = [...raw.getAudioTracks()];
        const video = raw.getVideoTracks()[0];
        if (video)
            tracks.push(attach(video));
        return new MediaStream(tracks);
    }, [attach]);
    const detach = (0, react_1.useCallback)(() => {
        engineRef.current?.setSource(null);
    }, []);
    // Persist on change (after restore, which happens in the state initializer).
    (0, react_1.useEffect)(() => {
        if (!persistKey)
            return;
        (0, persistence_1.writePersistedSettings)(localStorageOrNull(), persistKey, settings);
    }, [persistKey, settings]);
    // Dispose on unmount — engine never stops the caller's source track.
    (0, react_1.useEffect)(() => {
        return () => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            engineRef.current?.dispose();
            engineRef.current = null;
        };
    }, []);
    const active = settings.filterId !== 'none' ||
        settings.backgroundMode !== 'none' ||
        settings.faceSpriteId != null;
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
        setFilter,
        setBackgroundMode,
        setBackgroundImageUrl,
        setFaceSpriteId,
        attach,
        processStream,
        detach,
    }), [
        settings, active, outputTrack, backgrounds,
        setFilter, setBackgroundMode, setBackgroundImageUrl, setFaceSpriteId,
        attach, processStream, detach,
    ]);
}
//# sourceMappingURL=useMediaEffects.js.map