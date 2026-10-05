import { LocalRealtimeRouter } from '../../src/server';

test('subscription probes retain the exact admission token across an awaited read decision', async () => {
    const contexts = new Map<string, any>([['bob', { userId: 'bob', epoch: 1 }]]);
    let resolve!: (allowed: boolean) => void;
    let held = false;
    const router = new LocalRealtimeRouter({ authorize: () => held ? new Promise<boolean>(yes => { resolve = yes; }) : true });
    router._setHandle({ getClientContext: (id: string) => contexts.get(id) ?? null, sendToClient: () => true } as any);
    expect(await router.isClientSubscribed('bob', 'private')).toBe(false);
    await router.subscribeToChannel('bob', 'private'); held = true;
    const pending = router.isClientSubscribed('bob', 'private');
    router.unsubscribeFromChannel('bob', 'private'); held = false;
    await router.subscribeToChannel('bob', 'private'); resolve(true);
    expect(await pending).toBe(false);
    held = true; const replaced = router.isClientSubscribed('bob', 'private');
    contexts.set('bob', { userId: 'bob', epoch: 2 }); resolve(true);
    expect(await replaced).toBe(false);
});
