"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANVAS_RESERVED_META = void 0;
exports.canvasFrontMatter = canvasFrontMatter;
/** Runtime ownership/migration metadata is not source front matter. */
exports.CANVAS_RESERVED_META = new Set(['title', 'schemaVersion', 'importSourceRevision', 'tenantId', 'documentId', 'createdBy']);
function canvasFrontMatter(meta) {
    const frontMatter = {};
    for (const [key, value] of Object.entries(meta)) {
        if (!exports.CANVAS_RESERVED_META.has(key) && value !== undefined)
            frontMatter[key] = value;
    }
    return frontMatter;
}
//# sourceMappingURL=meta.js.map