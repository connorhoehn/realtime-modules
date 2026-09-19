import type { CalendarDate, IanaTimezone, IsoTimestamp } from './contracts';
export interface WorkDayWindow {
    day: CalendarDate;
    timezone: IanaTimezone;
    /** Inclusive UTC boundary. */
    start: IsoTimestamp;
    /** Exclusive UTC boundary. */
    end: IsoTimestamp;
    durationMs: number;
}
/** Resolve a person's calendar day to a half-open UTC interval. */
export declare function workDayWindow(day: CalendarDate, timezone: IanaTimezone): WorkDayWindow;
/** Half-open overlap: work ending exactly at midnight belongs to the prior day. */
export declare function intervalOverlapsWorkDay(startedAt: IsoTimestamp, endedAt: IsoTimestamp | undefined, window: Pick<WorkDayWindow, 'start' | 'end'>): boolean;
//# sourceMappingURL=dayWindow.d.ts.map