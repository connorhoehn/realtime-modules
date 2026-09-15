import { describe, it, expect } from '@jest/globals';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { AwarenessLedger } from '../../src/server/AwarenessLedger';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

function announce(name: string) {
    const doc = new Y.Doc();
    const a = new Awareness(doc);
    a.setLocalStateField('user', { displayName: name });
    return { a, update: b64(encodeAwarenessUpdate(a, [a.clientID])) };
}

describe('AwarenessLedger', () => {
    it('writes the departure a dropped client never sent, and receivers drop the state', () => {
        const ledger = new AwarenessLedger();
        const alice = announce('Alice');
        ledger.remember('conn-1', 'doc:x', alice.update);

        const peer = new Awareness(new Y.Doc());
        applyAwarenessUpdate(peer, Buffer.from(alice.update, 'base64'), 'test');
        expect(peer.getStates().has(alice.a.clientID)).toBe(true);

        const bye = ledger.departure('conn-1', 'doc:x');
        expect(bye).not.toBeNull();
        applyAwarenessUpdate(peer, Buffer.from(bye!, 'base64'), 'test');
        expect(peer.getStates().has(alice.a.clientID)).toBe(false);
        // Forgotten: nothing to say twice.
        expect(ledger.departure('conn-1', 'doc:x')).toBeNull();
    });

    it('says nothing for a client that already said goodbye itself', () => {
        const ledger = new AwarenessLedger();
        const alice = announce('Alice');
        ledger.remember('conn-1', 'doc:x', alice.update);
        alice.a.setLocalState(null);
        ledger.remember('conn-1', 'doc:x', b64(encodeAwarenessUpdate(alice.a, [alice.a.clientID])));
        expect(ledger.departure('conn-1', 'doc:x')).toBeNull();
    });

    it('covers every channel a dropped connection was on, and ignores garbage', () => {
        const ledger = new AwarenessLedger();
        const alice = announce('Alice');
        ledger.remember('conn-1', 'doc:x', alice.update);
        ledger.remember('conn-1', 'doc:y', alice.update);
        ledger.remember('conn-2', 'doc:x', announce('Bob').update);
        ledger.remember('conn-1', 'doc:z', 'not-base64-of-anything!!');
        const all = ledger.departures('conn-1');
        expect(all.map((d) => d.channel).sort()).toEqual(['doc:x', 'doc:y']);
        // Bob is still on doc:x.
        expect(ledger.departure('conn-2', 'doc:x')).not.toBeNull();
    });
});
