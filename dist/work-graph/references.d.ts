import type { WorkReference } from './contracts';
/** Serialize only stable identifiers and graph context; private labels never enter the token. */
export declare function encodeWorkReference(reference: WorkReference): string;
export declare function decodeWorkReference(encoded: string): WorkReference;
//# sourceMappingURL=references.d.ts.map