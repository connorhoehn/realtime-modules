/**
 * Tracks which users are present in which document channels.
 * Maintains a forward index (channel -> clients) and reverse index (client -> channels)
 * for efficient disconnect cleanup. Broadcasts aggregated presence to all clients
 * whenever the map changes.
 *
 * Lift note (CRDT Cut 1): copied verbatim from
 * src/realtime-fanout/crdt/DocumentPresenceService.ts. The `messageRouter`
 * parameter narrows to `MessageRouterContract`. Only the documented
 * surface (getClientData, broadcastToAll) is used. No logic changes.
 */
import type { MessageRouterContract } from './stores/MessageRouterContract';
type PresenceMode = 'editor' | 'reviewer' | 'reader';
interface UserInfo {
    userId: string;
    displayName: string;
    color: string;
    idle: boolean;
    /** Optional editor/reviewer/reader mode. When set, downstream
     *  consumers (e.g. the /documents list page mode badge) render a
     *  pencil / check / eye glyph. When absent, no badge renders. */
    mode?: PresenceMode;
}
declare class DocumentPresenceService {
    private messageRouter;
    private logger;
    documentPresenceMap: Map<string, Map<string, UserInfo>>;
    clientDocChannels: Map<string, Set<string>>;
    /**
     * @param messageRouter - message router for getClientData / broadcastToAll
     * @param logger
     */
    constructor(messageRouter: MessageRouterContract, logger: any);
    /**
     * Number of doc: channels currently tracking presence. Surfaced via
     * `crdtService.getStats().trackedPresenceChannels`. Was missing pre-fix:
     * the orchestrator read this without the getter existing, so the stat
     * was silently `undefined` (W4C wiring-gap finding).
     */
    get channelCount(): number;
    /**
     * Add a client to the document presence map for a doc: channel.
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     * @param channel
     */
    addClient(clientId: string, channel: string): void;
    /**
     * Remove a client from a specific doc: channel's presence map.
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     * @param channel
     */
    removeClient(clientId: string, channel: string): void;
    /**
     * Remove a client from ALL document presence maps (on disconnect).
     * Broadcasts updated presence to all connected clients.
     *
     * @param clientId
     */
    removeAllForClient(clientId: string): void;
    /**
     * Check whether a client is tracked in a given channel.
     *
     * @param clientId
     * @param channel
     * @returns boolean
     */
    hasClient(clientId: string, channel: string): boolean;
    /**
     * Update a client's idle state in a channel. Returns true if changed.
     * Broadcasts on change so the /documents list page idle dot updates
     * live (previously this only updated in-memory state).
     *
     * @param clientId
     * @param channel
     * @param idle
     * @returns whether the value changed
     */
    setIdle(clientId: string, channel: string, idle: boolean): boolean;
    /**
     * Update a client's mode (editor/reviewer/reader) in a channel.
     * Returns true if changed. Broadcasts on change so the /documents
     * list page mode badge updates live. Passing undefined or a
     * non-enum string clears the mode for this client.
     *
     * @param clientId
     * @param channel
     * @param mode
     * @returns whether the value changed
     */
    setMode(clientId: string, channel: string, mode: PresenceMode | undefined): boolean;
    /**
     * Return the raw presence map (for use in handleGetDocumentPresence).
     * @returns Map<string, Map<string, UserInfo>>
     */
    getPresence(): Map<string, Map<string, UserInfo>>;
    /**
     * Build and broadcast a documents:presence message to all connected clients.
     * Format: { type: 'documents:presence', documents: [{ documentId, users }] }
     */
    broadcastPresence(): void;
}
export = DocumentPresenceService;
//# sourceMappingURL=DocumentPresenceService.d.ts.map