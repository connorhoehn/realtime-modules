export declare const ASSISTANT_FLOOR_FRAME: "assistant-floor";
export type AssistantFloorVia = 'name' | 'follow-up' | 'hold';
export type AssistantFloorPhase = 'routing' | 'answering';
export interface AssistantFloor {
    /** Who the assistant is listening to (the app's user id; a guest's id as the app writes it). */
    userId: string;
    /** Their name as every viewer may see it. */
    name: string;
    /** How they got the floor. */
    via: AssistantFloorVia;
    /** Still being heard (`routing`) or being answered (`answering`). */
    phase: AssistantFloorPhase;
}
export interface AssistantFloorView {
    /** The call runs its assistant hands-free now. */
    handsfree: boolean;
    /** Who has the floor; always null while not hands-free. */
    floor: AssistantFloor | null;
    /** May this viewer take the floor by holding (from `read` only; frames never carry it). */
    mayHold?: boolean;
}
export interface AssistantFloorFrame {
    type: typeof ASSISTANT_FLOOR_FRAME;
    channel: string;
    handsfree: boolean;
    floor: AssistantFloor | null;
}
export declare const NO_ASSISTANT_FLOOR: AssistantFloorView;
/** Reads a floor body (a `read` answer or a frame); anything malformed is no floor. `mayHold` is kept when it is a boolean. */
export declare function parseAssistantFloor(body: unknown): AssistantFloorView;
/** The frame a server sends on `channel` when the floor changes (the shape the hook applies). */
export declare function assistantFloorFrame(channel: string, view: Pick<AssistantFloorView, 'handsfree' | 'floor'>): AssistantFloorFrame;
/** A floor frame for `channel`, parsed; null for any other frame. */
export declare function floorFromFrame(frame: unknown, channel: string): AssistantFloorView | null;
/** Any frame handler (method-typed, so a socket whose handler takes its own message type fits). */
type FrameHandler = {
    bivarianceHack(frame: unknown): void;
}['bivarianceHack'];
export interface AssistantFloorGateway {
    onMessage(handler: FrameHandler): () => void;
    connectionState?: string;
}
export interface UseAssistantFloorOptions {
    /** The call's chat channel the frames ride; null: nothing is read or applied. */
    channel: string | null;
    /** The initial (and reconnect) read; its answer goes through `parseAssistantFloor`. */
    read?: (signal: AbortSignal) => Promise<unknown>;
    /** The socket; default the nearest GatewayContext. */
    gateway?: AssistantFloorGateway | null;
    /** False: nothing is read or applied, the view is NO_ASSISTANT_FLOOR. Default true. */
    enabled?: boolean;
}
export interface UseAssistantFloorResult {
    view: AssistantFloorView;
    /** Read again now (e.g. after an action whose answer is not a floor body). */
    refresh: () => void;
    /** Apply a floor body the app already holds (e.g. a hold action's answer); `mayHold` kept unless the body sets it. */
    apply: (body: unknown) => void;
}
export declare function useAssistantFloor(options: UseAssistantFloorOptions): UseAssistantFloorResult;
export {};
//# sourceMappingURL=useAssistantFloor.d.ts.map