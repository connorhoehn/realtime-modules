import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';
export type AgentLoopRunPhase = 'planning' | 'running' | 'completed' | 'failed' | 'cancelled' | 'budget' | 'unknown';
export interface AgentLoopRunStep {
    id: string;
    nodeId?: string;
    title: string;
    kind?: string;
    status: string;
    iterations?: number;
    contextTokens?: number;
    error?: string;
    skipped?: boolean;
}
export interface AgentLoopRunControls {
    stop: boolean;
    pause: boolean;
    resume: boolean;
    pauseUnsupportedReason?: string;
}
/** The platform's AgentLoopView, as far as this hook reads it. Other fields pass through. */
export interface AgentLoopRunView {
    runId: string;
    pipelineId?: string;
    status: string;
    label?: string;
    startedAt?: string;
    elapsedMs?: number;
    model?: string;
    contextBudgetTokens?: number;
    contextTokens?: number;
    iterations?: number;
    steps: AgentLoopRunStep[];
    error?: string;
    executorRunId?: string;
    controls?: AgentLoopRunControls;
    [key: string]: unknown;
}
export interface UseAgentLoopRunOptions {
    /** platform-api origin, e.g. `http://localhost:13001`. */
    apiBaseUrl: string;
    /** Bearer for the reads and Stop; `null` disables both. */
    idToken: string | null;
    /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables live frames. */
    transport?: PipelineRunTransport | null;
    /** Safety-net re-read interval while the loop is not over. Default 5000; 0 disables. */
    pollMs?: number;
    /** Debounce between a live frame and the re-read it causes. Default 250. */
    frameDebounceMs?: number;
}
export interface AgentLoopStopResult {
    ok: boolean;
    status?: number;
    error?: string;
}
export interface UseAgentLoopRunResult {
    loop?: AgentLoopRunView;
    /** True until the first read answers. */
    loading: boolean;
    /** The platform answered 404: no such loop, or not one this person may see. */
    notFound: boolean;
    /** The last read's failure, when it failed for another reason. */
    error?: string;
    phase: AgentLoopRunPhase;
    status?: string;
    steps: AgentLoopRunStep[];
    /** The step running now, else the next pending one. */
    currentStep?: AgentLoopRunStep;
    stepsDone: number;
    stepsTotal: number;
    /** stepsDone / stepsTotal as 0–100, only when the plan has steps. A count of steps, not a time estimate. */
    percent?: number;
    startedAt?: string;
    /** The platform says Stop will do something (the loop is not over). */
    canStop: boolean;
    stopping: boolean;
    stop: () => Promise<AgentLoopStopResult>;
    /** Always false today — see `pauseUnsupportedReason`. */
    canPause: false;
    pauseUnsupportedReason: string;
    refresh: () => void;
}
export declare const DEFAULT_AGENT_LOOP_POLL_MS = 5000;
export declare const PAUSE_UNSUPPORTED_FALLBACK = "Pausing is not supported: a running step cannot be suspended. Stop ends the run.";
/** The platform's status word, folded into the phases a strip renders. */
export declare function agentLoopPhase(status: string | undefined): AgentLoopRunPhase;
export declare function isAgentLoopOver(phase: AgentLoopRunPhase): boolean;
/** Steps done / total and the step in hand. Pure. */
export declare function agentLoopProgress(steps: readonly AgentLoopRunStep[]): {
    stepsDone: number;
    stepsTotal: number;
    percent?: number;
    currentStep?: AgentLoopRunStep;
};
export declare function useAgentLoopRun(runId: string | null | undefined, opts: UseAgentLoopRunOptions): UseAgentLoopRunResult;
export default useAgentLoopRun;
//# sourceMappingURL=useAgentLoopRun.d.ts.map