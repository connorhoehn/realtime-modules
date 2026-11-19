/** The suffix a publisher's screen-share producer carries on its participant id. */
export declare const SCREEN_PID_SUFFIX = ":screen";
/** `hank:screen` → `hank`; `guest:inv-1-k3j2:screen` → `guest:inv-1-k3j2`; any other id is returned as it is. */
export declare function basePidOf(fullPid: string): string;
//# sourceMappingURL=basePid.d.ts.map