import type { DeckReviseTarget, DeckSpec } from './DeckSpec';
export type ConstraintMetric = 'words' | 'chars' | 'bullets' | 'slides';
/** What is measured. `bullet` is one bullet (a field target with an index). */
export type ConstraintSubject = 'title' | 'subtitle' | 'notes' | 'bullets' | 'bullet' | 'slide' | 'deck';
export type ConstraintKind = 'shorter' | 'longer' | 'delta' | 'max' | 'min' | 'exact' | 'unchanged' | 'removed';
export interface Constraint {
    kind: ConstraintKind;
    subject: ConstraintSubject;
    metric: ConstraintMetric;
    n?: number;
    /**
     * The slide the instruction names ("the title of slide 2" → 2), 1-based.
     * Measured on that slide when the run itself is not slide-scoped (#145).
     */
    slide?: number;
    /** The fragment of the instruction it came from, for the person reading the run. */
    phrase: string;
}
export interface ConstraintScope {
    slideId?: string | undefined;
    target?: DeckReviseTarget | undefined;
}
/** One measurement, before and after the proposal. */
export interface MeasuredFact {
    subject: ConstraintSubject;
    metric: ConstraintMetric | 'text';
    /** For a numeric metric. */
    before?: number;
    after?: number;
    /** For `text`: whether the subject's text changed. */
    changed?: boolean;
    label: string;
}
export interface ConstraintViolation {
    constraint: Constraint;
    fact: MeasuredFact;
    /** For the person, and for the model on its second try. */
    message: string;
}
export interface ConstraintCheck {
    constraints: Constraint[];
    facts: MeasuredFact[];
    violations: ConstraintViolation[];
}
/** Where a phrase applies when it names nothing: the field, else the slide, else the deck. */
export declare function defaultSubject(scope: ConstraintScope): ConstraintSubject;
/** The measurable constraints an instruction states, in the order they appear. */
export declare function parseConstraints(instruction: string, scope?: ConstraintScope): Constraint[];
export declare const countWords: (text: string | undefined) => number;
/** "Title: 3 → 2 words" / "Bullet 2: 12 → 9 words" / "Notes: unchanged". */
export declare function factLabel(fact: MeasuredFact, scope?: ConstraintScope): string;
/**
 * Measures `after` against `before` for every constraint, every claim the
 * summary makes, and the scope's default subjects, and names each constraint
 * the proposal does not meet.
 */
export declare function checkConstraints(constraints: Constraint[], before: DeckSpec, after: DeckSpec, scope?: ConstraintScope, claims?: Constraint[]): ConstraintCheck;
/**
 * The parts an edit changed, as short factual phrases in slide order —
 * "slide 1 subtitle", "slide 3 bullets", "slide 4 added", "deck title". The
 * deck subtitle is drawn on the title slide, so it is named by that slide.
 * Deterministic, from the two specs; never the model's word.
 */
export declare function describeChanges(before: DeckSpec, after: DeckSpec): string[];
/** The lines a run shows for its measurements: "Title: 3 → 2 words". */
export declare const factLines: (facts: MeasuredFact[]) => string[];
/**
 * The summary the run records: the model's sentence(s) minus any that claim
 * a direction the measurements contradict, then the measured facts. A summary
 * that loses every sentence falls back to a deterministic line.
 */
export declare function reconcileSummary(summary: string, facts: MeasuredFact[], fallback: string, changes?: string[]): string;
/** What the model is told on its second try. */
export declare function retryInstruction(instruction: string, violations: ConstraintViolation[]): string;
//# sourceMappingURL=deckConstraints.d.ts.map