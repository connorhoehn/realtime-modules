import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
export interface FaceSprite {
    id: string;
    /** Sentence-case name, no glyph (mockup 04: "Sunglasses", "Dog ears"). */
    label: string;
    /** The emoji the sprite draws, for a picker that wants a glyph beside the label. */
    icon?: string;
    render: (ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], w: number, h: number) => void;
}
export declare const FACE_SPRITES: FaceSprite[];
export declare function getSpriteById(id: string | null | undefined): FaceSprite | null;
//# sourceMappingURL=faceSprites.d.ts.map