export interface UseIdleDetectorOptions {
    /** Idle timeout in milliseconds (default: 120000 = 2 minutes). */
    timeoutMs?: number;
}
export interface UseIdleDetectorReturn {
    isIdle: boolean;
}
export declare function useIdleDetector(options?: UseIdleDetectorOptions): UseIdleDetectorReturn;
//# sourceMappingURL=useIdleDetector.d.ts.map