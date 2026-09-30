// Runs the parity scenario against a set of targets with a recording
// DynamoDB double. Shared by app-driver.js (realtime-examples' classes) and
// the library test (DynamoChatStore) so both sides execute identically.
'use strict';

const { NOW, ops } = require('./scenario');

function recorder() {
    let queue = [];
    let errors = [];
    const sent = [];
    return {
        sent,
        arm(op) { queue = [...(op.responses ?? [])]; errors = [...(op.errors ?? [])]; },
        async send(cmd) {
            sent.push({ name: cmd.constructor.name, input: JSON.parse(JSON.stringify(cmd.input)) });
            if (errors.length) { const e = errors.shift(); throw Object.assign(new Error(e.message), { name: e.name }); }
            return queue.length ? queue.shift() : {};
        },
    };
}

const normalize = (v) => {
    if (v instanceof Set) return { set: [...v].sort() };
    if (v === undefined) return { undefined: true };
    return JSON.parse(JSON.stringify(v));
};

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

/**
 * `makeTargets(client, op)` returns `{ messages, conversations, members,
 * reads, hooks }` bound to `client`. Returns one transcript entry per op.
 */
async function runScenario(makeTargets) {
    // Both `Date.now()` and a bare `new Date()` read the fixed clock.
    const RealDate = Date;
    class FixedDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
        static now() { return NOW; }
    }
    global.Date = FixedDate;
    try {
        const out = [];
        for (const op of ops) {
            const client = recorder();
            client.arm(op);
            const targets = makeTargets(client, op);
            let result;
            try {
                result = normalize(await targets[op.store][op.method](...JSON.parse(JSON.stringify(op.args))));
            } catch (err) {
                result = { threw: err.name + ': ' + err.message };
            }
            await flush();
            out.push({ op: `${op.store}.${op.method}`, sent: client.sent, result });
        }
        return out;
    } finally {
        global.Date = RealDate;
    }
}

module.exports = { runScenario };
