"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workDayWindow = workDayWindow;
exports.intervalOverlapsWorkDay = intervalOverlapsWorkDay;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEARCH_RADIUS_MS = 36 * 60 * 60 * 1_000;
function dateParts(day) {
    const match = DATE_RE.exec(day);
    if (!match)
        throw new RangeError('day must use YYYY-MM-DD');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const date = Number(match[3]);
    const checked = new Date(Date.UTC(year, month - 1, date));
    if (checked.getUTCFullYear() !== year
        || checked.getUTCMonth() !== month - 1
        || checked.getUTCDate() !== date) {
        throw new RangeError('day is not a valid calendar date');
    }
    return [year, month, date];
}
function nextDay(day) {
    const [year, month, date] = dateParts(day);
    const next = new Date(Date.UTC(year, month - 1, date + 1));
    return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()]
        .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
        .join('-');
}
function dateFormatter(timezone) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            calendar: 'gregory',
            numberingSystem: 'latn',
        });
    }
    catch {
        throw new RangeError('timezone must be a supported IANA timezone');
    }
}
function localDate(formatter, epochMs) {
    const parts = formatter.formatToParts(new Date(epochMs));
    const value = (kind) => parts.find((part) => part.type === kind)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    if (!year || !month || !day)
        throw new RangeError('timezone formatter did not return a calendar date');
    return `${year}-${month}-${day}`;
}
/** Earliest UTC millisecond whose local calendar date is targetDay. */
function startOfLocalDate(targetDay, timezone) {
    const [year, month, date] = dateParts(targetDay);
    const formatter = dateFormatter(timezone);
    const anchor = Date.UTC(year, month - 1, date);
    let low = anchor - SEARCH_RADIUS_MS;
    let high = anchor + SEARCH_RADIUS_MS;
    if (localDate(formatter, low) >= targetDay || localDate(formatter, high) < targetDay) {
        throw new RangeError('unable to resolve day in timezone');
    }
    while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (localDate(formatter, middle) < targetDay)
            low = middle;
        else
            high = middle;
    }
    if (localDate(formatter, high) !== targetDay) {
        throw new RangeError('day does not exist in timezone');
    }
    return high;
}
/** Resolve a person's calendar day to a half-open UTC interval. */
function workDayWindow(day, timezone) {
    const startMs = startOfLocalDate(day, timezone);
    const endMs = startOfLocalDate(nextDay(day), timezone);
    return {
        day,
        timezone,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        durationMs: endMs - startMs,
    };
}
/** Half-open overlap: work ending exactly at midnight belongs to the prior day. */
function intervalOverlapsWorkDay(startedAt, endedAt, window) {
    const startMs = Date.parse(startedAt);
    const endMs = endedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(endedAt);
    const windowStartMs = Date.parse(window.start);
    const windowEndMs = Date.parse(window.end);
    if (![startMs, endMs, windowStartMs, windowEndMs].every((value) => Number.isFinite(value) || value === Number.POSITIVE_INFINITY)) {
        throw new RangeError('interval timestamps must be valid ISO timestamps');
    }
    if (endMs < startMs)
        throw new RangeError('interval end must not precede its start');
    return startMs < windowEndMs && endMs > windowStartMs;
}
//# sourceMappingURL=dayWindow.js.map