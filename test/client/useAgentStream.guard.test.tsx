/** @jest-environment jsdom */
import { renderHook, act } from '@testing-library/react';
import { useAgentStream } from '../../src/client/useAgentStream';

describe('useAgentStream in-flight guard', () => {
    it('ignores a second send while the first stream is open, and calls fetch unbound', async () => {
        const seen: unknown[] = [];
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const fetchFn = function (this: unknown) {
            seen.push(this);
            return gate.then(() => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } }));
        };
        const { result } = renderHook(() => useAgentStream({ url: '/x', fetch: fetchFn as never } as never));
        let first!: Promise<void>;
        act(() => { first = result.current.sendMessage('one'); });
        await act(async () => { await result.current.sendMessage('two'); });
        expect(seen).toHaveLength(1);
        expect(seen[0] === undefined || seen[0] === globalThis).toBe(true);
        await act(async () => { release(); await first; });
        expect(result.current.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1);
    });
});
