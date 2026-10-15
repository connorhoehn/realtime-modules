"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestIdentityDirectory = exports.isRegister = exports.isAcquire = exports.isRenew = exports.FakeClusterRedis = exports.createRowsChatBackend = exports.RowsReadReceiptStore = exports.RowsChatStore = void 0;
// Subpath export: `@connorhoehn/realtime-modules/testing`.
//
// Test doubles for hosts of the realtime gateway. Nothing here is for
// production use; import it from test code only.
var rowsChatBackend_1 = require("./rowsChatBackend");
Object.defineProperty(exports, "RowsChatStore", { enumerable: true, get: function () { return rowsChatBackend_1.RowsChatStore; } });
Object.defineProperty(exports, "RowsReadReceiptStore", { enumerable: true, get: function () { return rowsChatBackend_1.RowsReadReceiptStore; } });
Object.defineProperty(exports, "createRowsChatBackend", { enumerable: true, get: function () { return rowsChatBackend_1.createRowsChatBackend; } });
var FakeClusterRedis_1 = require("./FakeClusterRedis");
Object.defineProperty(exports, "FakeClusterRedis", { enumerable: true, get: function () { return FakeClusterRedis_1.FakeClusterRedis; } });
Object.defineProperty(exports, "isRenew", { enumerable: true, get: function () { return FakeClusterRedis_1.isRenew; } });
Object.defineProperty(exports, "isAcquire", { enumerable: true, get: function () { return FakeClusterRedis_1.isAcquire; } });
Object.defineProperty(exports, "isRegister", { enumerable: true, get: function () { return FakeClusterRedis_1.isRegister; } });
var testIdentities_1 = require("./testIdentities");
Object.defineProperty(exports, "TestIdentityDirectory", { enumerable: true, get: function () { return testIdentities_1.TestIdentityDirectory; } });
//# sourceMappingURL=index.js.map