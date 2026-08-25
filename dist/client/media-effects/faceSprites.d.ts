import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
export interface FaceSprite {
    id: string;
    label: string;
    render: (ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], w: number, h: number) => void;
}
export declare const FACE_SPRITES: FaceSprite[];
export declare function getSpriteById(id: string | null | undefined): FaceSprite | null;
//# sourceMappingURL=faceSprites.d.ts.map