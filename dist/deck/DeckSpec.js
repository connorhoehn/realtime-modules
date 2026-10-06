"use strict";
// Vendored from platform-api src/deck/DeckSpec.ts at commit 34d17f7 (34d17f78c171b05ae1b146ed8e2fff1f7bec1de2).
// Unchanged except import paths (NodeNext `.js` suffixes). Extraction into a shared
// package is queued in docs/ui-components-queue.md — do not fork behaviour here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.REVISE_TARGET_FIELDS = exports.SLIDE_ID_PATTERN = exports.MAX_SOURCES_PER_SLIDE = exports.MAX_QUOTE_CHARS = exports.MAX_CHART_SERIES = exports.MAX_CHART_LABELS = exports.MAX_NOTES_CHARS = exports.MAX_EYEBROW_CHARS = exports.MAX_SUBTITLE_CHARS = exports.MAX_TITLE_CHARS = exports.MAX_BULLET_CHARS = exports.MAX_BULLETS_PER_SLIDE = exports.MAX_SLIDES = void 0;
exports.validateDeckSpec = validateDeckSpec;
exports.assertDeckSpec = assertDeckSpec;
exports.parseDeckSpecJson = parseDeckSpecJson;
exports.deckSources = deckSources;
exports.validateReviseTarget = validateReviseTarget;
exports.describeReviseTarget = describeReviseTarget;
// ---------------------------------------------------------------------------
// Caps — the limits a slide can hold and still be read from the back of a room
// ---------------------------------------------------------------------------
exports.MAX_SLIDES = 40;
exports.MAX_BULLETS_PER_SLIDE = 8;
exports.MAX_BULLET_CHARS = 200;
exports.MAX_TITLE_CHARS = 120;
exports.MAX_SUBTITLE_CHARS = 200;
exports.MAX_EYEBROW_CHARS = 60;
exports.MAX_NOTES_CHARS = 2000;
exports.MAX_CHART_LABELS = 24;
exports.MAX_CHART_SERIES = 6;
exports.MAX_QUOTE_CHARS = 400;
exports.MAX_SOURCES_PER_SLIDE = 10;
/** Slide ids stay filename- and handle-safe: they end up in preview handles and blob keys. */
exports.SLIDE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THEMES = new Set(['product', 'engineering', 'plain']);
const LAYOUTS = new Set(['title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'image']);
const SPEC_KEYS = new Set(['title', 'subtitle', 'theme', 'slides']);
const SLIDE_KEYS = new Set([
    'id', 'layout', 'title', 'eyebrow', 'bullets', 'columns', 'chart', 'quote', 'image', 'notes', 'sources',
]);
const SOURCE_KEYS = new Set(['documentId', 'anchor', 'title']);
const CHART_KEYS = new Set(['kind', 'labels', 'series']);
const SERIES_KEYS = new Set(['name', 'values']);
const QUOTE_KEYS = new Set(['text', 'by']);
const IMAGE_KEYS = new Set(['alt']);
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Collapses whitespace so a cap counts characters a reader would see. */
function clean(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed || undefined;
}
/** Notes keep their line breaks; only trailing space goes. */
function cleanMultiline(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.replace(/[ \t]+$/gm, '').trim();
    return trimmed || undefined;
}
function unknownKeys(object, allowed) {
    return Object.keys(object).filter((key) => !allowed.has(key) && object[key] !== undefined);
}
/**
 * Validates one deck. Returns every problem it found rather than the first, so
 * a draft that has to be re-asked for can be re-asked for once.
 */
function validateDeckSpec(input) {
    const errors = [];
    if (!isObject(input))
        return { ok: false, errors: ['deck: expected an object'] };
    for (const key of unknownKeys(input, SPEC_KEYS))
        errors.push(`deck: unknown field '${key}'`);
    const title = clean(input.title);
    if (!title)
        errors.push('deck.title: required');
    else if (title.length > exports.MAX_TITLE_CHARS)
        errors.push(`deck.title: longer than ${exports.MAX_TITLE_CHARS} characters`);
    const subtitle = clean(input.subtitle);
    if (input.subtitle !== undefined && !subtitle)
        errors.push('deck.subtitle: must be a non-empty string when present');
    if (subtitle && subtitle.length > exports.MAX_SUBTITLE_CHARS)
        errors.push(`deck.subtitle: longer than ${exports.MAX_SUBTITLE_CHARS} characters`);
    let theme;
    if (input.theme !== undefined) {
        if (typeof input.theme !== 'string' || !THEMES.has(input.theme))
            errors.push("deck.theme: must be 'product', 'engineering' or 'plain'");
        else
            theme = input.theme;
    }
    if (!Array.isArray(input.slides) || input.slides.length === 0) {
        errors.push('deck.slides: at least one slide is required');
        return { ok: false, errors };
    }
    if (input.slides.length > exports.MAX_SLIDES)
        errors.push(`deck.slides: ${input.slides.length} slides, the cap is ${exports.MAX_SLIDES}`);
    const slides = [];
    const seenIds = new Set();
    input.slides.slice(0, exports.MAX_SLIDES).forEach((raw, index) => {
        const slide = validateSlide(raw, index, seenIds, errors);
        if (slide)
            slides.push(slide);
    });
    if (errors.length)
        return { ok: false, errors };
    return {
        ok: true,
        spec: {
            title: title,
            ...(subtitle ? { subtitle } : {}),
            ...(theme ? { theme } : {}),
            slides,
        },
    };
}
function validateSlide(raw, index, seenIds, errors) {
    const at = `slides[${index}]`;
    if (!isObject(raw)) {
        errors.push(`${at}: expected an object`);
        return null;
    }
    for (const key of unknownKeys(raw, SLIDE_KEYS))
        errors.push(`${at}: unknown field '${key}'`);
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!exports.SLIDE_ID_PATTERN.test(id)) {
        errors.push(`${at}.id: must match ${exports.SLIDE_ID_PATTERN} (letters, digits, '_' and '-')`);
    }
    else if (seenIds.has(id)) {
        errors.push(`${at}.id: '${id}' is used twice`);
    }
    else {
        seenIds.add(id);
    }
    const layout = typeof raw.layout === 'string' ? raw.layout : '';
    if (!LAYOUTS.has(layout))
        errors.push(`${at}.layout: must be one of ${[...LAYOUTS].join(', ')}`);
    const title = clean(raw.title);
    if (!title)
        errors.push(`${at}.title: required`);
    else if (title.length > exports.MAX_TITLE_CHARS)
        errors.push(`${at}.title: longer than ${exports.MAX_TITLE_CHARS} characters`);
    const eyebrow = clean(raw.eyebrow);
    if (raw.eyebrow !== undefined && !eyebrow)
        errors.push(`${at}.eyebrow: must be a non-empty string when present`);
    if (eyebrow && eyebrow.length > exports.MAX_EYEBROW_CHARS)
        errors.push(`${at}.eyebrow: longer than ${exports.MAX_EYEBROW_CHARS} characters`);
    const notes = cleanMultiline(raw.notes);
    if (notes && notes.length > exports.MAX_NOTES_CHARS)
        errors.push(`${at}.notes: longer than ${exports.MAX_NOTES_CHARS} characters`);
    const bullets = raw.bullets === undefined ? undefined : validateBullets(raw.bullets, `${at}.bullets`, errors);
    const columns = raw.columns === undefined ? undefined : validateColumns(raw.columns, at, errors);
    const chart = raw.chart === undefined ? undefined : validateChart(raw.chart, `${at}.chart`, errors);
    const quote = raw.quote === undefined ? undefined : validateQuote(raw.quote, `${at}.quote`, errors);
    const image = raw.image === undefined ? undefined : validateImage(raw.image, `${at}.image`, errors);
    // A layout's own payload belongs to it and nowhere else; bullets are the one
    // thing every layout may carry, as supporting text.
    if (layout === 'bullets' && !bullets?.length)
        errors.push(`${at}: a 'bullets' slide needs at least one bullet`);
    if (layout === 'two-column' && !columns)
        errors.push(`${at}: a 'two-column' slide needs columns`);
    if (layout === 'chart' && !chart)
        errors.push(`${at}: a 'chart' slide needs a chart`);
    if (layout === 'quote' && !quote)
        errors.push(`${at}: a 'quote' slide needs a quote`);
    if (layout === 'image' && !image)
        errors.push(`${at}: an 'image' slide needs image.alt`);
    if (columns && layout !== 'two-column')
        errors.push(`${at}.columns: only a 'two-column' slide may carry columns`);
    if (chart && layout !== 'chart')
        errors.push(`${at}.chart: only a 'chart' slide may carry a chart`);
    if (quote && layout !== 'quote')
        errors.push(`${at}.quote: only a 'quote' slide may carry a quote`);
    if (image && layout !== 'image')
        errors.push(`${at}.image: only an 'image' slide may carry an image`);
    const sources = validateSources(raw.sources, at, errors);
    if (!id || !title || !LAYOUTS.has(layout))
        return null;
    return {
        id,
        layout: layout,
        title,
        ...(eyebrow ? { eyebrow } : {}),
        ...(bullets?.length ? { bullets } : {}),
        ...(columns ? { columns } : {}),
        ...(chart ? { chart } : {}),
        ...(quote ? { quote } : {}),
        ...(image ? { image } : {}),
        ...(notes ? { notes } : {}),
        sources,
    };
}
function validateBullets(raw, at, errors) {
    if (!Array.isArray(raw)) {
        errors.push(`${at}: expected an array of strings`);
        return [];
    }
    if (raw.length > exports.MAX_BULLETS_PER_SLIDE)
        errors.push(`${at}: ${raw.length} bullets, the cap is ${exports.MAX_BULLETS_PER_SLIDE}`);
    const out = [];
    raw.slice(0, exports.MAX_BULLETS_PER_SLIDE).forEach((item, index) => {
        const text = clean(item);
        if (!text) {
            errors.push(`${at}[${index}]: must be a non-empty string`);
            return;
        }
        if (text.length > exports.MAX_BULLET_CHARS) {
            errors.push(`${at}[${index}]: longer than ${exports.MAX_BULLET_CHARS} characters`);
            return;
        }
        out.push(text);
    });
    return out;
}
function validateColumns(raw, at, errors) {
    if (!Array.isArray(raw) || raw.length !== 2) {
        errors.push(`${at}.columns: expected exactly two arrays of bullets`);
        return undefined;
    }
    const left = validateBullets(raw[0], `${at}.columns[0]`, errors);
    const right = validateBullets(raw[1], `${at}.columns[1]`, errors);
    if (!left.length && !right.length) {
        errors.push(`${at}.columns: both columns are empty`);
        return undefined;
    }
    return [left, right];
}
function validateChart(raw, at, errors) {
    if (!isObject(raw)) {
        errors.push(`${at}: expected an object`);
        return undefined;
    }
    for (const key of unknownKeys(raw, CHART_KEYS))
        errors.push(`${at}: unknown field '${key}'`);
    const kind = raw.kind === 'bar' || raw.kind === 'line' ? raw.kind : undefined;
    if (!kind)
        errors.push(`${at}.kind: must be 'bar' or 'line'`);
    const labels = [];
    if (!Array.isArray(raw.labels) || raw.labels.length === 0) {
        errors.push(`${at}.labels: at least one label is required`);
    }
    else {
        if (raw.labels.length > exports.MAX_CHART_LABELS)
            errors.push(`${at}.labels: ${raw.labels.length} labels, the cap is ${exports.MAX_CHART_LABELS}`);
        raw.labels.slice(0, exports.MAX_CHART_LABELS).forEach((label, index) => {
            const text = clean(label);
            if (!text) {
                errors.push(`${at}.labels[${index}]: must be a non-empty string`);
                return;
            }
            labels.push(text.slice(0, 40));
        });
    }
    const series = [];
    if (!Array.isArray(raw.series) || raw.series.length === 0) {
        errors.push(`${at}.series: at least one series is required`);
    }
    else {
        if (raw.series.length > exports.MAX_CHART_SERIES)
            errors.push(`${at}.series: ${raw.series.length} series, the cap is ${exports.MAX_CHART_SERIES}`);
        raw.series.slice(0, exports.MAX_CHART_SERIES).forEach((entry, index) => {
            const where = `${at}.series[${index}]`;
            if (!isObject(entry)) {
                errors.push(`${where}: expected an object`);
                return;
            }
            for (const key of unknownKeys(entry, SERIES_KEYS))
                errors.push(`${where}: unknown field '${key}'`);
            const name = clean(entry.name);
            if (!name) {
                errors.push(`${where}.name: required`);
                return;
            }
            if (!Array.isArray(entry.values) || entry.values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
                errors.push(`${where}.values: expected finite numbers`);
                return;
            }
            if (entry.values.length !== labels.length) {
                errors.push(`${where}.values: ${entry.values.length} values for ${labels.length} labels`);
                return;
            }
            series.push({ name: name.slice(0, 40), values: entry.values });
        });
    }
    if (!kind || !labels.length || !series.length)
        return undefined;
    return { kind, labels, series };
}
function validateQuote(raw, at, errors) {
    if (!isObject(raw)) {
        errors.push(`${at}: expected an object`);
        return undefined;
    }
    for (const key of unknownKeys(raw, QUOTE_KEYS))
        errors.push(`${at}: unknown field '${key}'`);
    const text = clean(raw.text);
    const by = clean(raw.by);
    if (!text)
        errors.push(`${at}.text: required`);
    else if (text.length > exports.MAX_QUOTE_CHARS)
        errors.push(`${at}.text: longer than ${exports.MAX_QUOTE_CHARS} characters`);
    if (!by)
        errors.push(`${at}.by: required — an unattributed quote is not a source`);
    if (!text || !by)
        return undefined;
    return { text, by: by.slice(0, 80) };
}
function validateImage(raw, at, errors) {
    if (!isObject(raw)) {
        errors.push(`${at}: expected an object`);
        return undefined;
    }
    for (const key of unknownKeys(raw, IMAGE_KEYS))
        errors.push(`${at}: unknown field '${key}'`);
    const alt = clean(raw.alt);
    if (!alt) {
        errors.push(`${at}.alt: required`);
        return undefined;
    }
    if (alt.length > exports.MAX_BULLET_CHARS) {
        errors.push(`${at}.alt: longer than ${exports.MAX_BULLET_CHARS} characters`);
        return undefined;
    }
    return { alt };
}
/**
 * The rule that makes this a grounded generator: a slide with no citation is
 * refused. Rendering it would be the deck asserting something no input said.
 */
function validateSources(raw, at, errors) {
    if (!Array.isArray(raw) || raw.length === 0) {
        errors.push(`${at}.sources: every slide must cite at least one source document`);
        return [];
    }
    if (raw.length > exports.MAX_SOURCES_PER_SLIDE)
        errors.push(`${at}.sources: ${raw.length} sources, the cap is ${exports.MAX_SOURCES_PER_SLIDE}`);
    const out = [];
    raw.slice(0, exports.MAX_SOURCES_PER_SLIDE).forEach((entry, index) => {
        const where = `${at}.sources[${index}]`;
        if (!isObject(entry)) {
            errors.push(`${where}: expected an object`);
            return;
        }
        for (const key of unknownKeys(entry, SOURCE_KEYS))
            errors.push(`${where}: unknown field '${key}'`);
        const documentId = clean(entry.documentId);
        const title = clean(entry.title);
        const anchor = clean(entry.anchor);
        if (!documentId) {
            errors.push(`${where}.documentId: required`);
            return;
        }
        if (!title) {
            errors.push(`${where}.title: required`);
            return;
        }
        out.push({
            documentId: documentId.slice(0, 200),
            ...(anchor ? { anchor: anchor.slice(0, 120) } : {}),
            title: title.slice(0, 160),
        });
    });
    if (!out.length)
        errors.push(`${at}.sources: no usable source survived validation`);
    return out;
}
/** Validate or throw. The message lists every problem, in order. */
function assertDeckSpec(input) {
    const result = validateDeckSpec(input);
    if (result.ok)
        return result.spec;
    throw new Error(`invalid DeckSpec: ${result.errors.join('; ')}`);
}
/**
 * Pulls the deck out of whatever a model said: a bare object, a fenced block,
 * or prose with the JSON somewhere inside it. Returns `undefined` when there is
 * nothing parseable — the caller reports that, it does not improvise a deck.
 */
function parseDeckSpecJson(text) {
    if (typeof text !== 'string')
        return undefined;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidates = [fenced?.[1], text].filter((value) => typeof value === 'string');
    for (const candidate of candidates) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start < 0 || end <= start)
            continue;
        try {
            return JSON.parse(candidate.slice(start, end + 1));
        }
        catch {
            continue;
        }
    }
    return undefined;
}
/** Every distinct document a deck cites, first-cited first — the Sources slide's content. */
function deckSources(spec) {
    const seen = new Map();
    for (const slide of spec.slides) {
        for (const source of slide.sources) {
            const key = `${source.documentId}#${source.anchor ?? ''}`;
            if (!seen.has(key))
                seen.set(key, source);
        }
    }
    return [...seen.values()];
}
exports.REVISE_TARGET_FIELDS = [
    'title', 'eyebrow', 'subtitle', 'bullets', 'columns', 'chart', 'quote', 'image', 'notes',
];
/** Fields a slide may carry whatever its layout; the rest belong to one layout. */
const ANY_LAYOUT_FIELDS = new Set(['title', 'eyebrow', 'bullets', 'notes']);
const LAYOUT_OF_FIELD = {
    columns: 'two-column', chart: 'chart', quote: 'quote', image: 'image',
};
/**
 * Checks a target against the deck it will be applied to. `slideId` must
 * already name a slide of `spec` (the caller checks that first) unless the
 * target is the deck's `subtitle`.
 */
function validateReviseTarget(raw, spec, slideId) {
    if (!isObject(raw))
        return { ok: false, error: 'target must be an object: { field, index? }' };
    const extra = Object.keys(raw).filter((key) => key !== 'field' && key !== 'index' && raw[key] !== undefined);
    if (extra.length)
        return { ok: false, error: `target: unknown field '${extra[0]}'` };
    const field = raw.field;
    if (typeof field !== 'string' || !exports.REVISE_TARGET_FIELDS.includes(field)) {
        return { ok: false, error: `target.field must be one of ${exports.REVISE_TARGET_FIELDS.join(', ')}` };
    }
    const f = field;
    let index;
    if (raw.index !== undefined && raw.index !== null) {
        if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) {
            return { ok: false, error: 'target.index must be a whole number, 0 or more' };
        }
        if (f !== 'bullets' && f !== 'columns')
            return { ok: false, error: `target.index applies only to bullets and columns, not ${f}` };
        index = raw.index;
    }
    if (f === 'subtitle') {
        // The deck's own field. A slideId alongside it is harmless (the editor
        // sends the selected slide); it does not narrow anything.
        return { ok: true, target: { field: f } };
    }
    if (!slideId)
        return { ok: false, error: `target.field '${f}' is a slide's field — name the slide with slideId` };
    const slide = spec.slides.find((candidate) => candidate.id === slideId);
    if (!slide)
        return { ok: false, error: 'slideId does not name a slide in this deck' };
    const layout = LAYOUT_OF_FIELD[f];
    if (!ANY_LAYOUT_FIELDS.has(f) && layout && slide.layout !== layout) {
        return { ok: false, error: `slide '${slide.id}' is a '${slide.layout}' slide; only a '${layout}' slide has ${f}` };
    }
    if (f === 'bullets' && index !== undefined) {
        const count = slide.bullets?.length ?? 0;
        if (index >= count)
            return { ok: false, error: `slide '${slide.id}' has ${count} bullet${count === 1 ? '' : 's'}; target.index ${index} is not one of them` };
    }
    if (f === 'columns' && index !== undefined && index > 1) {
        return { ok: false, error: 'target.index for columns is 0 (left) or 1 (right)' };
    }
    return { ok: true, target: { field: f, ...(index !== undefined ? { index } : {}) } };
}
/** How a target reads in a prompt, a log line or an event: "bullets[2]", "columns[1]", "notes". */
function describeReviseTarget(target) {
    return target.index === undefined ? target.field : `${target.field}[${target.index}]`;
}
//# sourceMappingURL=DeckSpec.js.map