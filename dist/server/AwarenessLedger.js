"use strict";
// AwarenessLedger — what the gateway needs to say goodbye on a client's behalf.
//
// y-protocols awareness has no server. A client announces its own state, and
// its own departure, and everyone else believes the last thing they heard
// until a 30-second sweep drops states that have gone quiet. A client that
// leaves cleanly sends a null state first. A client that does not — a closed
// tab, a hard navigation, a dropped socket — sends nothing, and the others
// list a person as editing a document they left for half a minute.
//
// The gateway knows the moment a connection unsubscribes or drops. What it did
// not know was WHICH awareness entries were that connection's: the update is an
// opaque blob to it. The blob is not opaque — it is `[n, (clientID, clock,
// stateJSON) × n]` — so this reads enough of each update to remember the
// y-protocols client ids and clocks a connection has announced, and on
// departure writes the one update the client would have sent: the same ids,
// clock + 1, state null. Receivers apply it exactly as they would the client's
// own.
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AwarenessLedger = void 0;
const encoding = __importStar(require("lib0/encoding"));
const decoding = __importStar(require("lib0/decoding"));
class AwarenessLedger {
    /** channel → connection → y-protocols clientID → last clock seen. */
    _ids = new Map();
    /** Read an inbound update and remember what it announced. Unreadable input is ignored. */
    remember(clientId, channel, updateB64) {
        let dec;
        let len;
        try {
            dec = decoding.createDecoder(new Uint8Array(Buffer.from(updateB64, 'base64')));
            len = decoding.readVarUint(dec);
        }
        catch {
            return;
        }
        for (let i = 0; i < len; i++) {
            let yid;
            let clock;
            let state;
            try {
                yid = decoding.readVarUint(dec);
                clock = decoding.readVarUint(dec);
                state = decoding.readVarString(dec);
            }
            catch {
                return;
            }
            const byConn = this._ids.get(channel) ?? new Map();
            this._ids.set(channel, byConn);
            const ids = byConn.get(clientId) ?? new Map();
            byConn.set(clientId, ids);
            // A null state is the client's own departure for that id: nothing
            // left to say on its behalf.
            if (state === 'null')
                ids.delete(yid);
            else
                ids.set(yid, clock);
        }
    }
    /**
     * The departure update for one connection on one channel, or null when it
     * announced nothing (or already said goodbye). Forgets the connection.
     */
    departure(clientId, channel) {
        const byConn = this._ids.get(channel);
        const ids = byConn?.get(clientId);
        byConn?.delete(clientId);
        if (byConn && byConn.size === 0)
            this._ids.delete(channel);
        if (!ids || ids.size === 0)
            return null;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, ids.size);
        for (const [yid, clock] of ids) {
            encoding.writeVarUint(enc, yid);
            encoding.writeVarUint(enc, clock + 1);
            encoding.writeVarString(enc, 'null');
        }
        return Buffer.from(encoding.toUint8Array(enc)).toString('base64');
    }
    /** Every channel a dropped connection still has a state on, with its departure. */
    departures(clientId) {
        const out = [];
        for (const channel of [...this._ids.keys()]) {
            const update = this.departure(clientId, channel);
            if (update)
                out.push({ channel, update });
        }
        return out;
    }
}
exports.AwarenessLedger = AwarenessLedger;
exports.default = AwarenessLedger;
//# sourceMappingURL=AwarenessLedger.js.map