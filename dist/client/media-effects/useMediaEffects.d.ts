import { type FilterPreset } from './presets';
import { type FaceSprite } from './faceSprites';
import { type BackgroundOption } from './backgrounds';
import { type MediaEffectsAssets } from './assets';
import { type BackgroundMode, type WarmupTarget } from './engine';
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
export declare function useMediaEffects(opts?: UseMediaEffectsOptions): MediaEffectsController;
//# sourceMappingURL=useMediaEffects.d.ts.map