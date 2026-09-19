export interface WorkGraphEventDeclaration {
    name: string;
    namespace: 'work-graph';
    schema: Record<string, unknown>;
    transport: 'durable' | 'signal';
    producer: string;
    description: string;
    tags: string[];
    version: 1;
    compatibilityMode: 'backward';
    queue?: string;
    retention?: number;
    dlqAfterAttempts?: number;
}
export declare const workGraphLifecycleDeclarations: WorkGraphEventDeclaration[];
export declare const workGraphHeartbeatDeclaration: WorkGraphEventDeclaration;
export declare const workGraphProjectionChangedDeclaration: WorkGraphEventDeclaration;
export declare const workGraphEventDeclarations: readonly [...WorkGraphEventDeclaration[], WorkGraphEventDeclaration, WorkGraphEventDeclaration];
/** Event-catalog JSON Schema cannot enforce UTF-8 envelope byte length. */
export declare function isWithinWorkGraphEventLimit(value: unknown): boolean;
//# sourceMappingURL=eventDeclarations.d.ts.map