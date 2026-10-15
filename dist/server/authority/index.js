"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bearerSubprotocolAuth = exports.tokenFromSubprotocol = exports.BEARER_SUBPROTOCOL = exports.withAuthorityCache = exports.gateOnPrincipal = exports.withPrincipalRevalidation = exports.revalidatingAuth = exports.principalIsCurrent = exports.normalizeCallPayload = exports.createChannelAuthority = exports.DEFAULT_EPHEMERAL_SERVICES = exports.DEFAULT_FAMILY_SERVICES = exports.defineChannelFamilies = exports.partitionGuard = void 0;
// realtime-modules/src/server/authority — 0.116 authority primitives.
// Re-exported from `@connorhoehn/realtime-modules/server`.
var families_1 = require("./families");
Object.defineProperty(exports, "partitionGuard", { enumerable: true, get: function () { return families_1.partitionGuard; } });
Object.defineProperty(exports, "defineChannelFamilies", { enumerable: true, get: function () { return families_1.defineChannelFamilies; } });
Object.defineProperty(exports, "DEFAULT_FAMILY_SERVICES", { enumerable: true, get: function () { return families_1.DEFAULT_FAMILY_SERVICES; } });
Object.defineProperty(exports, "DEFAULT_EPHEMERAL_SERVICES", { enumerable: true, get: function () { return families_1.DEFAULT_EPHEMERAL_SERVICES; } });
var engine_1 = require("./engine");
Object.defineProperty(exports, "createChannelAuthority", { enumerable: true, get: function () { return engine_1.createChannelAuthority; } });
Object.defineProperty(exports, "normalizeCallPayload", { enumerable: true, get: function () { return engine_1.normalizeCallPayload; } });
var principal_1 = require("./principal");
Object.defineProperty(exports, "principalIsCurrent", { enumerable: true, get: function () { return principal_1.principalIsCurrent; } });
Object.defineProperty(exports, "revalidatingAuth", { enumerable: true, get: function () { return principal_1.revalidatingAuth; } });
Object.defineProperty(exports, "withPrincipalRevalidation", { enumerable: true, get: function () { return principal_1.withPrincipalRevalidation; } });
Object.defineProperty(exports, "gateOnPrincipal", { enumerable: true, get: function () { return principal_1.gateOnPrincipal; } });
var verdictCache_1 = require("./verdictCache");
Object.defineProperty(exports, "withAuthorityCache", { enumerable: true, get: function () { return verdictCache_1.withAuthorityCache; } });
var bearer_1 = require("./bearer");
Object.defineProperty(exports, "BEARER_SUBPROTOCOL", { enumerable: true, get: function () { return bearer_1.BEARER_SUBPROTOCOL; } });
Object.defineProperty(exports, "tokenFromSubprotocol", { enumerable: true, get: function () { return bearer_1.tokenFromSubprotocol; } });
Object.defineProperty(exports, "bearerSubprotocolAuth", { enumerable: true, get: function () { return bearer_1.bearerSubprotocolAuth; } });
//# sourceMappingURL=index.js.map