import type { AnyWorkReference, WorkReferenceV2 } from './contractsV2';
import type { WorkReference } from './contracts';
/** Serialize only stable identifiers and graph context; private labels never enter the token. */
export declare function encodeWorkReference(reference: WorkReference): string;
export declare function decodeWorkReference(encoded: string): WorkReference;
/** Opt-in writer. Do not enable until the recipient resolver accepts v2. */
export declare function encodeWorkReferenceV2(reference: WorkReferenceV2): string;
/** Upgraded reader: old v1 readers remain strict and continue rejecting v2. */
export declare function decodeAnyWorkReference(encoded: string): AnyWorkReference;
//# sourceMappingURL=references.d.ts.map