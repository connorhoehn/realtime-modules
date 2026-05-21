"use strict";
/**
 * AG-UI v0.1.x protocol event types — server emitter contract.
 *
 * Mirrors the 28 event-type catalog documented in
 * `ui-components/src/components/agents/README.md`. Field names match the
 * AG-UI spec exactly; the type system enforces the three regressions the
 * design spec flags:
 *
 *   1. TOOL_CALL_START.toolCallName   (NOT toolName, NOT name)
 *   2. TOOL_CALL_ARGS.delta           (NOT args)
 *   3. TOOL_CALL_RESULT is a separate event AFTER TOOL_CALL_END with
 *      messageId + content (NOT inlined on TOOL_CALL_END)
 *   4. RUN_ERROR.message              (NOT error)
 *   5. STATE_DELTA.delta is a JsonPatchOp[] (RFC 6902)
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map