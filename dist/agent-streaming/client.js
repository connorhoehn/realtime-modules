"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAgentStream = void 0;
// Re-export the useAgentStream hook as a Lambda-friendly subpath
// that doesn't pull in Yjs-bound siblings from /client.
// Pairs with the server emitter exported from `./agent-streaming`.
var useAgentStream_1 = require("../client/useAgentStream");
Object.defineProperty(exports, "useAgentStream", { enumerable: true, get: function () { return useAgentStream_1.useAgentStream; } });
//# sourceMappingURL=client.js.map