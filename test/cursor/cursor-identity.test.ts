// A cursor's identity is the server's, not the frame's — the same rule 0.98.5
// applied to chat senders. An authenticated connection's metadata.userId /
// displayName / userInitials / userColor are replaced, keys off the allowlist
// are dropped, and anonymous connections keep the pre-0.114 behaviour.
import { CursorService } from '../../src/cursor/CursorService';

const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(contexts: Record<string, unknown>, config: Record<string, unknown> = {}) {
    const sent: Array<{ channel: string; message: any }> = [];
    const router = {
        getClientData: (id: string) => (contexts[id] ? { userContext: contexts[id] } : null),
        sendToClient: jest.fn(),
        sendToChannel: jest.fn((channel: string, message: unknown) => { sent.push({ channel, message }); }),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(),
    } as any;
    const svc = new CursorService({ messageRouter: router, logger, config: { throttleInterval: 0, ...config } });
    return { svc, sent };
}
const lastMetadata = (sent: Array<{ message: any }>) => {
    const m = sent[sent.length - 1]!.message;
    return (m.cursor ?? m).metadata;
};
const forged = { userId: 'victim', displayName: 'Victim Person', userInitials: 'VP', userColor: '#123456', secret: 'x', mode: 'canvas' };

describe('CursorService identity', () => {
    it('replaces a forged identity with the auth context and drops other keys', async () => {
        const { svc, sent } = setup({ c1: { userId: 'u-ann', displayName: 'Ann Lee' } });
        await svc.handleAction('c1', 'update', { channel: 'ch', position: { x: 1, y: 2 }, metadata: forged });
        const m = lastMetadata(sent);
        expect(m).toMatchObject({ mode: 'canvas', userId: 'u-ann', displayName: 'Ann Lee', userInitials: 'AL' });
        expect(m.userColor).not.toBe('#123456');
        expect(m).not.toHaveProperty('secret');
        expect(JSON.stringify(sent)).not.toMatch(/Victim|victim|123456/);
        svc.shutdown();
    });
    it('derives the same colour for the same user across connections', async () => {
        const { svc, sent } = setup({ a: { userId: 'u-ann', displayName: 'Ann' }, b: { userId: 'u-ann', displayName: 'Ann' } });
        await svc.handleAction('a', 'update', { channel: 'ch', position: { x: 1, y: 2 } });
        const first = lastMetadata(sent).userColor;
        await svc.handleAction('b', 'update', { channel: 'ch', position: { x: 1, y: 2 } });
        expect(lastMetadata(sent).userColor).toBe(first);
        svc.shutdown();
    });
    it('keeps allowlisted keys, including a chosen colour only when listed', async () => {
        const { svc, sent } = setup({ c1: { userId: 'u-ann', displayName: 'Ann Lee' } }, { metadataAllowlist: ['userColor', 'tool'] });
        await svc.handleAction('c1', 'update', { channel: 'ch', position: { x: 1, y: 2 }, metadata: { ...forged, tool: 'pen' } });
        expect(lastMetadata(sent)).toMatchObject({ userColor: '#123456', tool: 'pen', userId: 'u-ann' });
        expect(lastMetadata(sent)).not.toHaveProperty('secret');
        svc.shutdown();
    });
    it('uses resolveIdentity when given', async () => {
        const { svc, sent } = setup({ c1: { userId: 'raw', sub: 's1', label: 'Zed Q' } }, { resolveIdentity: (ctx: any) => ({ userId: ctx.sub, displayName: ctx.label }) });
        await svc.handleAction('c1', 'update', { channel: 'ch', position: { x: 1, y: 2 }, metadata: forged });
        expect(lastMetadata(sent)).toMatchObject({ userId: 's1', displayName: 'Zed Q', userInitials: 'ZQ' });
        svc.shutdown();
    });
    it('leaves an anonymous connection as before', async () => {
        const { svc, sent } = setup({});
        await svc.handleAction('anon', 'update', { channel: 'ch', position: { x: 1, y: 2 }, metadata: forged });
        expect(lastMetadata(sent)).toMatchObject({ userInitials: 'VP', userColor: '#123456', secret: 'x' });
        svc.shutdown();
    });
});
