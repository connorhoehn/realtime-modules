import { type WorkSourceKind } from './contracts';
export interface WorkGraphEventDeclaration {
    name: string;
    namespace: 'work-graph';
    schema: Record<string, unknown>;
    transport: 'durable' | 'signal';
    /** The service that normally writes this source. */
    producer: string;
    /**
     * Every service allowed to publish it. A source usually has exactly one
     * writer, but a document may be written either by the gateway (a CRDT page)
     * or by the platform (a generated presentation, whose row the platform's own
     * deck store writes). Both must reach the SAME node — identity is the
     * source and the document id, not who observed it — so they publish the same
     * declared event rather than one inventing a parallel source.
     */
    producers: readonly string[];
    description: string;
    tags: string[];
    version: 1;
    compatibilityMode: 'backward';
    queue?: string;
    retention?: number;
    dlqAfterAttempts?: number;
}
/** Every service allowed to publish a source's lifecycle event. */
export declare function workGraphProducersFor(source: WorkSourceKind): readonly string[];
export declare const workGraphLifecycleDeclarations: WorkGraphEventDeclaration[];
export declare const workGraphHeartbeatDeclaration: WorkGraphEventDeclaration;
export declare const workGraphProjectionChangedDeclaration: WorkGraphEventDeclaration;
export declare const workGraphEventDeclarations: readonly [...WorkGraphEventDeclaration[], WorkGraphEventDeclaration, WorkGraphEventDeclaration];
/** Event-catalog JSON Schema cannot enforce UTF-8 envelope byte length. */
export declare function isWithinWorkGraphEventLimit(value: unknown): boolean;
//# sourceMappingURL=eventDeclarations.d.ts.map