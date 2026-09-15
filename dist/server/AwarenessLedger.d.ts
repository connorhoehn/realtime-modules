export declare class AwarenessLedger {
    /** channel → connection → y-protocols clientID → last clock seen. */
    private readonly _ids;
    /** Read an inbound update and remember what it announced. Unreadable input is ignored. */
    remember(clientId: string, channel: string, updateB64: string): void;
    /**
     * The departure update for one connection on one channel, or null when it
     * announced nothing (or already said goodbye). Forgets the connection.
     */
    departure(clientId: string, channel: string): string | null;
    /** Every channel a dropped connection still has a state on, with its departure. */
    departures(clientId: string): Array<{
        channel: string;
        update: string;
    }>;
}
export default AwarenessLedger;
//# sourceMappingURL=AwarenessLedger.d.ts.map