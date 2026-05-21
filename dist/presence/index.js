"use strict";
// realtime-modules/src/presence/index.ts
//
// @connorhoehn/realtime-modules/presence — barrel export.
//
// In-process presence tracking lifted from gateway in Wave 2.
// See PresenceService.ts header for what was lifted vs. left behind.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceManifest = exports.PresenceService = void 0;
const PresenceService_1 = __importDefault(require("./PresenceService"));
exports.PresenceService = PresenceService_1.default;
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "PresenceManifest", { enumerable: true, get: function () { return manifest_1.PresenceManifest; } });
//# sourceMappingURL=index.js.map