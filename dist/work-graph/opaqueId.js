"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.opaqueWorkId = opaqueWorkId;
const sha256_1 = require("lib0/hash/sha256");
/** Deterministic identity, not an authorization token. No source fields escape. */
function opaqueWorkId(prefix, ...parts) {
    const bytes = (0, sha256_1.digest)(new TextEncoder().encode(JSON.stringify(parts)));
    const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `wg_${prefix}_${hash}`;
}
//# sourceMappingURL=opaqueId.js.map