// realtime-modules/src/adapters/tiptap/canvas/CommentHighlight.ts
//
// Shows WHERE the comments are.
//
// The gutter knows which sentence a thread is about — `anchors.ts` gives it a
// range that survives editing — but until something paints that range, the
// thread is a card floating beside a page with no visible tie to the prose. A
// reader cannot tell which words are being argued about. This extension is the
// tie: it paints the anchored characters inside the text.
//
// ## Decorations, not a mark
//
// The obvious implementation is a `comment` mark, and it is wrong. A mark is
// DOCUMENT content: it lives in the ProseMirror doc, therefore in the Y.Doc,
// therefore in the markdown this canvas serialises to. Three consequences, all
// bad:
//
//   • the markdown file grows comment ids that mean nothing outside this app,
//     and markdown has no syntax for them, so the round trip loses them or
//     invents a wrapper
//   • deleting a comment becomes a document EDIT — you would have to rewrite
//     the prose to remove a highlight, which lands in everyone's undo stack,
//     in the change history, and in every reviewer's diff
//   • two users disagreeing about which thread is "active" would fight over
//     shared state, because a mark is shared state
//
// A highlight is a VIEW concern: it is derived, per-reader, and disposable.
// ProseMirror already has exactly that primitive — a `DecorationSet` computed
// from a plugin state, rendered over the document without touching it. Nothing
// here ever writes a transaction that changes `doc`.
//
// ## Plain-text offsets vs ProseMirror positions
//
// An anchor resolves to a range in the PLAIN-TEXT space of `anchors.ts`: every
// text run concatenated in document order, block boundaries contributing
// nothing. ProseMirror positions are a different number line — they count node
// boundaries, so an offset and a position drift apart by 2 at every block, more
// inside nested lists. Handing a plain-text offset to `Decoration.inline` is
// therefore a silent off-by-N that grows with the document: right in paragraph
// one, a word late in paragraph two, a sentence late by paragraph six.
//
// The bridge is `textSegments`: walk the ProseMirror doc, and for each text
// node record where it starts on BOTH number lines. That reproduces the
// plain-text space exactly, because y-prosemirror maps each ProseMirror text
// node to one Y.js text run and nothing else contributes characters — an inline
// atom (an image, a hard break) is a `Y.XmlElement` sibling of the text, so it
// counts zero on both sides, and a block boundary is a node token on the PM
// side and nothing at all on the plain-text side. Within a text node the two
// spaces advance together, so the conversion is a per-segment intersection plus
// a shift. A plain range spanning a block boundary yields SEVERAL PM ranges —
// one per text node it touches — which is also what the DOM wants, since the
// gap between two paragraphs is not text and must not be painted.
//
// The known gap: `anchors.ts` counts a Y.js embed (a non-string delta insert)
// as one character, and no ProseMirror text node corresponds to it. y-tiptap
// does not produce embeds — inline nodes become elements — so this cannot
// happen today, and if it ever does the effect is a highlight that is short by
// one per embed, not a crash.
//
// ## Class contract (the consuming app owns the colours)
//
//   .canvas-comment              every painted range, whatever its state
//   .canvas-comment--open        a live thread
//   .canvas-comment--active      the thread the reader is focused on; must be
//                                distinguishable from the rest at a glance
//   .canvas-comment--resolved    settled; render this QUIETER, not louder
//   [data-comment-id="<id>"]     the thread each span belongs to, for the
//                                gutter to hover-link against
//
// The modifier is derived from the `state` string, so a consumer that adds a
// fourth state gets `.canvas-comment--<state>` for free. No colours, no inline
// styles, no `!important` — only class names.
//
// Each decoration asks for its own `nodeName: 'span'`, and that is not
// cosmetic. ProseMirror flattens the inline decorations covering one stretch of
// text into a single DOM element UNLESS a decoration names its own element:
// `class` and `style` are concatenated across them, but every other attribute
// is overwritten by the last one in. Without the explicit `nodeName`, two
// overlapping comments share one span and one `data-comment-id`, so the second
// thread is invisible to any selector the gutter writes. With it, they nest —
// one span per thread, each carrying its own id and state class, and a
// translucent background stacks so busy passages read as busier for free.

import { Extension } from '@tiptap/core';
import type { Node as PmDocNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Doc as YDoc } from 'yjs';
import { isCanvasAnchor, resolveAnchor, type CanvasAnchor } from './anchors';

/** Base class on every painted range. See the class contract above. */
export const CANVAS_COMMENT_CLASS = 'canvas-comment';

/** Matches `CANVAS_BODY_KEY` in `useCanvasDocument`; not imported — that module is a React hook. */
const DEFAULT_FRAGMENT_KEY = 'body';

/**
 * A thread's lifecycle state, as far as the highlight is concerned.
 *
 * The three the app has today, left open to extension: the class name is
 * derived from the string, so a new state needs CSS and nothing else here.
 */
export type CommentHighlightState =
  | 'open'
  | 'resolved'
  | 'active'
  | (string & Record<never, never>);

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

/**
 * Meta payload. Each field is optional and `undefined` means "leave it alone",
 * which is why `ydoc` is checked against `undefined` rather than falsiness —
 * `null` is a legitimate value meaning "there is no document yet".
 */
interface CommentHighlightMeta {
  ydoc?: YDoc | null;
  comments?: CommentHighlightRef[];
}

export const commentHighlightPluginKey = new PluginKey<CommentHighlightPluginState>(
  'canvasCommentHighlight',
);

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
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

// ---------------------------------------------------------------------------
// The two number lines
// ---------------------------------------------------------------------------

interface TextSegment {
  /** Offset of this run's first character in the document's plain text. */
  plain: number;
  /** ProseMirror position of the same character. */
  pm: number;
  length: number;
}

/**
 * Every text node in the doc, with its start on both number lines.
 *
 * Rebuilt per computation rather than cached: the doc it describes is replaced
 * by every transaction, and a segment table keyed on anything cheaper than
 * "this exact doc" is an off-by-N waiting to happen.
 */
function textSegments(doc: PmDocNode): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = 0;
  doc.descendants((node, pos) => {
    // Only text carries characters. Returning false stops the walk from
    // descending into a text node's (nonexistent) children.
    if (!node.isText) return true;
    const length = node.text?.length ?? 0;
    if (length > 0) {
      segments.push({ plain, pm: pos, length });
      plain += length;
    }
    return false;
  });
  return segments;
}

/**
 * A plain-text range as ProseMirror ranges.
 *
 * Several, not one: the range can cross block boundaries, and the boundary
 * itself is not text. Adjacent results are merged so a phrase split across two
 * text nodes by a bold run is still one decoration rather than two abutting
 * ones that would each get their own DOM span.
 */
function toPmRanges(
  segments: TextSegment[],
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const segment of segments) {
    const segmentEnd = segment.plain + segment.length;
    if (segmentEnd <= from) continue;
    if (segment.plain >= to) break; // segments are in document order
    const start = segment.pm + Math.max(from - segment.plain, 0);
    const end = segment.pm + Math.min(to, segmentEnd) - segment.plain;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.to === start) previous.to = end;
    else ranges.push({ from: start, to: end });
  }
  return ranges;
}

/**
 * `canvas-comment canvas-comment--active`, etc.
 *
 * The state is sanitised because it arrives from a stored comment row and ends
 * up in a `class` attribute: an unfiltered value there is a selector the app
 * never anticipated, and potentially an attribute break.
 */
function classesFor(prefix: string, state: string): string {
  const modifier = String(state)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return modifier ? `${prefix} ${prefix}--${modifier}` : prefix;
}

function buildDecorations(
  doc: PmDocNode,
  ydoc: YDoc | null,
  options: CommentHighlightOptions,
  comments: CommentHighlightRef[],
): DecorationSet {
  if (!ydoc || comments.length === 0) return DecorationSet.empty;

  const segments = textSegments(doc);
  const decorations: Decoration[] = [];

  for (const comment of comments) {
    const anchor = comment.anchor;
    // Shape check before `.key`: a comment row can come back from storage with
    // a missing or half-migrated anchor, and one bad row must not blank the
    // highlights on every other thread.
    if (!isCanvasAnchor(anchor) || anchor.key !== options.fragmentKey) continue;
    if (options.hideResolved && comment.state === 'resolved') continue;

    let range: ReturnType<typeof resolveAnchor> = null;
    try {
      range = resolveAnchor(ydoc, anchor);
    } catch {
      // `resolveAnchor` is documented not to throw, but it reaches into the
      // Y.Doc by name and `getXmlFragment` does throw if that name is already
      // bound to another type. One malformed anchor should cost one highlight.
      continue;
    }
    // An orphan — the text this comment was about is gone. Paint nothing; the
    // gutter still shows the thread, using `anchor.quote` for context.
    if (!range) continue;

    const attributes = {
      // See the class contract: the explicit element is what stops two
      // overlapping comments from collapsing into one span with one id.
      nodeName: 'span',
      class: classesFor(options.classPrefix, comment.state),
      'data-comment-id': comment.id,
    };
    for (const pmRange of toPmRanges(segments, range.from, range.to)) {
      decorations.push(
        Decoration.inline(pmRange.from, pmRange.to, attributes, {
          commentId: comment.id,
          // Mirrors the association `createAnchor` picks: text typed against
          // either edge of the highlight lands OUTSIDE it, so the highlight
          // does not creep over words the comment never mentioned.
          inclusiveStart: false,
          inclusiveEnd: false,
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

export const CommentHighlight = Extension.create<CommentHighlightOptions>({
  name: 'commentHighlight',

  addOptions() {
    return {
      ydoc: null,
      fragmentKey: DEFAULT_FRAGMENT_KEY,
      comments: [],
      hideResolved: false,
      classPrefix: CANVAS_COMMENT_CLASS,
      onCommentClick: null,
    };
  },

  addCommands() {
    return {
      setCommentHighlights:
        (comments) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(tr.setMeta(commentHighlightPluginKey, { comments } satisfies CommentHighlightMeta));
          }
          return true;
        },

      refreshCommentHighlights:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(commentHighlightPluginKey, {} satisfies CommentHighlightMeta));
          return true;
        },

      setCommentHighlightDocument:
        (ydoc) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(tr.setMeta(commentHighlightPluginKey, { ydoc } satisfies CommentHighlightMeta));
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin<CommentHighlightPluginState>({
        key: commentHighlightPluginKey,

        state: {
          init(_config, state) {
            return {
              ydoc: options.ydoc,
              comments: options.comments,
              decorations: buildDecorations(state.doc, options.ydoc, options, options.comments),
            };
          },

          apply(tr, previous) {
            const meta = tr.getMeta(commentHighlightPluginKey) as CommentHighlightMeta | undefined;
            if (meta) {
              const ydoc = meta.ydoc !== undefined ? meta.ydoc : previous.ydoc;
              const comments = meta.comments ?? previous.comments;
              return {
                ydoc,
                comments,
                decorations: buildDecorations(tr.doc, ydoc, options, comments),
              };
            }
            if (!tr.docChanged) return previous;

            // MAPPING, not a rebuild, on an ordinary edit — and this is the
            // load-bearing choice. y-tiptap flushes a ProseMirror change into
            // the Y.Doc from its plugin VIEW, which runs after every `apply`
            // has already returned. A rebuild here would resolve anchors
            // against the Y.Doc as it was BEFORE this keystroke and snap every
            // highlight back one edit, so highlights would lag the text by one
            // character forever. `tr.mapping` describes the change we are
            // inside of, so it is the only description available that is
            // current. It also handles remote edits, which arrive as ordinary
            // transactions once y-tiptap has applied them.
            //
            // The cost: a highlight whose text is deleted is dropped (an empty
            // inline decoration does not survive mapping), and undoing that
            // delete does not bring it back — the anchor would resolve again,
            // but nothing re-reads it. A `refreshCommentHighlights()` restores
            // it, and the gutter issues one whenever its thread list changes.
            return {
              ydoc: previous.ydoc,
              comments: previous.comments,
              decorations: previous.decorations.map(tr.mapping, tr.doc),
            };
          },
        },

        props: {
          decorations(state) {
            return commentHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },

          handleClick(view, pos, event) {
            const onCommentClick = options.onCommentClick;
            if (!onCommentClick) return false;

            const decorations = commentHighlightPluginKey.getState(view.state)?.decorations;
            if (!decorations) return false;

            // `find` is inclusive at both ends, so a click on the boundary
            // between two comments matches both. Prefer a strict interior hit,
            // and among ties take the NARROWEST range: when comments overlap,
            // the tighter one is the more specific thing the reader aimed at.
            const touching = decorations.find(pos, pos);
            if (touching.length === 0) return false;
            const interior = touching.filter((d) => pos > d.from && pos < d.to);
            const candidates = interior.length > 0 ? interior : touching;
            const best = candidates.reduce((a, b) => (b.to - b.from < a.to - a.from ? b : a));

            const id = (best.spec as { commentId?: unknown }).commentId;
            if (typeof id !== 'string') return false;
            onCommentClick(id, event);

            // Deliberately NOT handled. Returning true would swallow the click
            // and the reader could no longer put a caret in a commented word —
            // opening a thread must not make its sentence uneditable.
            return false;
          },
        },
      }),
    ];
  },
});
