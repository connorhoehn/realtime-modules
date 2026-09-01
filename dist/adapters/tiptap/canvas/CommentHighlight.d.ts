import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import type { Doc as YDoc } from 'yjs';
import { type CanvasAnchor } from './anchors';
/** Base class on every painted range. See the class contract above. */
export declare const CANVAS_COMMENT_CLASS = "canvas-comment";
/**
 * A thread's lifecycle state, as far as the highlight is concerned.
 *
 * The three the app has today, left open to extension: the class name is
 * derived from the string, so a new state needs CSS and nothing else here.
 */
export type CommentHighlightState = 'open' | 'resolved' | 'active' | (string & Record<never, never>);
/** One thread, as the gutter knows it. */
export interface CommentHighlightRef {
    /** The thread id handed back to `onCommentClick`. */
    id: string;
    /** Where it points, in the plain-text space of `anchors.ts`. */
    anchor: CanvasAnchor;
    state: CommentHighlightState;
}
export interface CommentHighlightOptions {
    /**
     * The Y.Doc the editor is bound to — the SAME one, not a copy. Anchors are
     * relative positions into its structure, so a different doc (even one synced
     * from it moments ago) can resolve them to stale offsets.
     */
    ydoc: YDoc | null;
    /**
     * The Y root the editor renders. Anchors naming a different root are skipped
     * rather than mapped: their offsets belong to another document's number line,
     * and mapping them here would paint confident nonsense.
     */
    fragmentKey: string;
    /** Initial threads. Replaced wholesale by `setCommentHighlights`. */
    comments: CommentHighlightRef[];
    /**
     * Drop resolved threads entirely instead of painting them quietly. A
     * preference, not a default: a resolved highlight is still the evidence that
     * a decision was made about this sentence.
     */
    hideResolved: boolean;
    /** Class-name root, for an app that namespaces its CSS. */
    classPrefix: string;
    /**
     * Fired when the reader clicks inside a highlight, so the gutter can scroll
     * that thread into view and focus it.
     *
     * Read at click time from the options this extension was CONFIGURED with, so
     * it must be stable for the editor's lifetime — a React consumer should hand
     * over a ref-backed dispatcher rather than a fresh closure per render, the
     * same way it would for any other Tiptap option.
     */
    onCommentClick: ((id: string, event: MouseEvent) => void) | null;
}
interface CommentHighlightPluginState {
    /**
     * Lives here rather than in the extension's options because Tiptap hands a
     * command its OWN copy of the options object: mutating `this.options.ydoc`
     * inside a command is invisible to the plugin, which closes over the
     * original. Plugin state is the one place both halves can agree on.
     */
    ydoc: YDoc | null;
    comments: CommentHighlightRef[];
    decorations: DecorationSet;
}
export declare const commentHighlightPluginKey: PluginKey<CommentHighlightPluginState>;
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentHighlight: {
            /** Replace the painted threads — call this whenever the gutter's list changes. */
            setCommentHighlights: (comments: CommentHighlightRef[]) => ReturnType;
            /** Recompute from the Y.Doc without changing the thread list. */
            refreshCommentHighlights: () => ReturnType;
            /** Point at a different Y.Doc (a document swap) and recompute. */
            setCommentHighlightDocument: (ydoc: YDoc | null) => ReturnType;
        };
    }
}
export declare const CommentHighlight: Extension<CommentHighlightOptions, any>;
export {};
//# sourceMappingURL=CommentHighlight.d.ts.map