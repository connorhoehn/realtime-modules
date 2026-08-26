import { type FilterPreset } from './presets';
import { type FaceSprite } from './faceSprites';
import { type BackgroundOption } from './backgrounds';
import { type MediaEffectsAssets } from './assets';
import { MediaEffectsEngine, type BackgroundMode, type WarmupTarget } from './engine';
import { type MediaEffectsSettings } from './persistence';
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
export declare function useMediaEffects(opts?: UseMediaEffectsOptions): MediaEffectsController;
//# sourceMappingURL=useMediaEffects.d.ts.map