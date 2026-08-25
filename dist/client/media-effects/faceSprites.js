"use strict";
// realtime-modules/src/client/media-effects/faceSprites.ts
//
// Face sprite renderers. Use system emoji glyphs rendered large at
// landmark-anchored positions — gives you actual Apple/Google emoji art
// instead of hand-drawn primitives, with zero asset pipeline (which also
// keeps this subpath free of external fetches).
//
// Anchoring uses MediaPipe Face Landmarker's 468-point mesh. Each sprite
// computes its position, scale, and rotation from the relevant landmarks
// so it tracks head movement.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FACE_SPRITES = void 0;
exports.getSpriteById = getSpriteById;
const faceLandmarker_1 = require("./faceLandmarker");
function px(l, w, h) {
    return { x: l.x * w, y: l.y * h };
}
function faceWidth(landmarks, w, h) {
    const l = px(landmarks[faceLandmarker_1.LANDMARK.LEFT_CHEEK], w, h);
    const r = px(landmarks[faceLandmarker_1.LANDMARK.RIGHT_CHEEK], w, h);
    return Math.hypot(r.x - l.x, r.y - l.y);
}
function faceRotation(landmarks, w, h) {
    const l = px(landmarks[faceLandmarker_1.LANDMARK.LEFT_CHEEK], w, h);
    const r = px(landmarks[faceLandmarker_1.LANDMARK.RIGHT_CHEEK], w, h);
    return Math.atan2(r.y - l.y, r.x - l.x);
}
/**
 * Draw an emoji glyph centered at (0,0) in the current transform.
 * Uses Apple Color Emoji / system emoji fonts for native-quality rendering.
 */
function drawEmoji(ctx, emoji, fontSize) {
    ctx.font = `${fontSize}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 0, 0);
}
const dogEars = {
    id: 'dog-ears',
    label: '🐶 Dog Ears',
    render: (ctx, lms, w, h) => {
        const top = px(lms[faceLandmarker_1.LANDMARK.FOREHEAD_TOP], w, h);
        const fw = faceWidth(lms, w, h);
        const rot = faceRotation(lms, w, h);
        const size = fw * 1.6;
        // Position the emoji row so its center sits a bit above the forehead
        const liftY = fw * 0.7;
        ctx.save();
        ctx.translate(top.x, top.y - liftY);
        ctx.rotate(rot);
        drawEmoji(ctx, '🐶', size);
        ctx.restore();
    },
};
const sunglasses = {
    id: 'sunglasses',
    label: '🕶️ Sunglasses',
    render: (ctx, lms, w, h) => {
        const leftOuter = px(lms[faceLandmarker_1.LANDMARK.LEFT_EYE_OUTER], w, h);
        const rightOuter = px(lms[faceLandmarker_1.LANDMARK.RIGHT_EYE_OUTER], w, h);
        const mid = { x: (leftOuter.x + rightOuter.x) / 2, y: (leftOuter.y + rightOuter.y) / 2 };
        const eyeSpan = Math.hypot(rightOuter.x - leftOuter.x, rightOuter.y - leftOuter.y);
        const rot = Math.atan2(rightOuter.y - leftOuter.y, rightOuter.x - leftOuter.x);
        const size = eyeSpan * 1.7;
        ctx.save();
        ctx.translate(mid.x, mid.y);
        ctx.rotate(rot);
        drawEmoji(ctx, '🕶️', size);
        ctx.restore();
    },
};
const mustache = {
    id: 'mustache',
    label: '🥸 Disguise',
    render: (ctx, lms, w, h) => {
        const nose = px(lms[faceLandmarker_1.LANDMARK.NOSE_TIP], w, h);
        const fw = faceWidth(lms, w, h);
        const rot = faceRotation(lms, w, h);
        // 🥸 already includes glasses + nose + mustache + eyebrows, so anchor
        // on the nose tip — the glyph covers the whole upper face naturally.
        const size = fw * 1.6;
        ctx.save();
        ctx.translate(nose.x, nose.y);
        ctx.rotate(rot);
        drawEmoji(ctx, '🥸', size);
        ctx.restore();
    },
};
const partyHat = {
    id: 'party-hat',
    label: '🎉 Party',
    render: (ctx, lms, w, h) => {
        const top = px(lms[faceLandmarker_1.LANDMARK.FOREHEAD_TOP], w, h);
        const fw = faceWidth(lms, w, h);
        const rot = faceRotation(lms, w, h);
        const size = fw * 1.2;
        ctx.save();
        ctx.translate(top.x, top.y - fw * 0.55);
        ctx.rotate(rot);
        drawEmoji(ctx, '🎉', size);
        ctx.restore();
    },
};
const crown = {
    id: 'crown',
    label: '👑 Crown',
    render: (ctx, lms, w, h) => {
        const top = px(lms[faceLandmarker_1.LANDMARK.FOREHEAD_TOP], w, h);
        const fw = faceWidth(lms, w, h);
        const rot = faceRotation(lms, w, h);
        const size = fw * 1.3;
        ctx.save();
        ctx.translate(top.x, top.y - fw * 0.45);
        ctx.rotate(rot);
        drawEmoji(ctx, '👑', size);
        ctx.restore();
    },
};
exports.FACE_SPRITES = [dogEars, sunglasses, mustache, partyHat, crown];
function getSpriteById(id) {
    if (!id)
        return null;
    return exports.FACE_SPRITES.find((s) => s.id === id) ?? null;
}
//# sourceMappingURL=faceSprites.js.map