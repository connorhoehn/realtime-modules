"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseHangoutPlanInput = exports.HangoutPlanValidationError = exports.HANGOUT_PLAN_LIMITS = void 0;
var plan_1 = require("./plan");
Object.defineProperty(exports, "HANGOUT_PLAN_LIMITS", { enumerable: true, get: function () { return plan_1.HANGOUT_PLAN_LIMITS; } });
Object.defineProperty(exports, "HangoutPlanValidationError", { enumerable: true, get: function () { return plan_1.HangoutPlanValidationError; } });
Object.defineProperty(exports, "parseHangoutPlanInput", { enumerable: true, get: function () { return plan_1.parseHangoutPlanInput; } });
__exportStar(require("../client/hangout-rooms/api"), exports);
//# sourceMappingURL=index.js.map