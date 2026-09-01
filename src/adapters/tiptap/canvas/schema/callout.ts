// realtime-modules/src/adapters/tiptap/canvas/schema/callout.ts
//
// The Confluence-style callout panel — Info / Note / Warning / Success / Error.
//
// ## Why this reuses the macro fence instead of `:::info`
//
// `:::info` is the syntax users *type*, and it is the input rule below. It is
// deliberately NOT the syntax we store. The chassis rejected directives as a
// storage form for a reason that applies here unchanged
// (`distributed-core/src/applications/document/MACRO-MARKDOWN.md`): a tool that
// has never heard of `:::` parses the body as an ordinary paragraph and
// re-serialises it as one, so the panel silently evaporates on the return trip.
// The fenced macro is the only construct CommonMark guarantees no other tool
// will rewrite, and the chassis already parses, serialises and preserves it.
//
// ## The stored form
//
// A callout is a **blockquote whose first child is a `macro:callout` marker**:
//
//     > ```macro:callout
//     > variant: warning
//     > ```
//     >
//     > Heads up
//     >
//     > - one
//     > - two
//
// The marker macro carries the variant; the blockquote carries the body. That
// split exists because `MacroBlock` is a LEAF by design — fenced content is
// literal, so it cannot hold parsed block children — while requirement 2 says a
// callout must hold real paragraphs and lists. Stuffing the body into the YAML
// as a string would satisfy the fence but demote the user's prose to an opaque
// scalar: no marks, no mentions, no suggestions, and a code block rather than
// readable text anywhere else. Wrapping in a blockquote keeps every inner block
// a first-class chassis block, and a blockquote holding a macro is already
// legal in the chassis model, so this form is a serialise/parse fixed point
// today with no chassis change at all. It also degrades honestly: GitHub shows
// an indented quote with a small labelled header, which is roughly what a
// callout is.
//
// ## Why this node wraps blocks rather than being a textblock
//
// `MacroNode` is a textblock because its content IS its YAML payload. A callout
// is the opposite: the YAML is one attribute and the content is prose the user
// edits normally. `content: 'block+'` is what lets a bullet list, a nested
// quote or a second paragraph live inside the panel — a textblock could only
// ever hold one run of characters, which would make "put a checklist in a
// warning" impossible.
//
// ## Reaching markdown (closed)
//
// `pmModel.ts` now carries the node in both directions: `blockToPm` recognises
// a blockquote whose first child is a `macro:callout` marker and emits this
// node, and `pmBlocksToModel` re-emits the marker ahead of the body.
// `callout-roundtrip.test.ts` demands the same bytes back for every variant.
//
// One case stays a plain blockquote on purpose: a marker with NO body after it.
// See the comment on the `blockquote` case in `pmModel.ts`.

import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';

export const CALLOUT_NODE_NAME = 'callout';

/**
 * The macro name the marker leaf uses inside the blockquote.
 *
 * `pmModel.ts` is the intended consumer: `blockToPm` should recognise a
 * `blockquote` whose first child is a `macro` with this name and emit a
 * `callout` node from the remaining children, and `pmBlocksToModel` should do
 * the inverse. Both directions are pure data — no chassis change is required,
 * because the chassis already round-trips this shape.
 */
export const CALLOUT_MACRO_NAME = 'callout';

export const CALLOUT_VARIANTS = ['info', 'note', 'warning', 'success', 'error'] as const;

export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

const DEFAULT_VARIANT: CalloutVariant = 'info';

/**
 * The variant a value denotes, or `info`.
 *
 * Applied on the way IN from the DOM and again on the way OUT to it. Both
 * matter: an imported document, a hand-edited markdown file or a CRDT merge can
 * all put an arbitrary string here, and echoing it into `data-variant` would
 * hand an attacker a selector the consuming app's CSS never anticipated. A
 * closed set is also what lets the app theme the panel exhaustively rather than
 * defensively.
 */
export function normalizeCalloutVariant(value: unknown): CalloutVariant {
  return (CALLOUT_VARIANTS as readonly string[]).includes(value as string)
    ? (value as CalloutVariant)
    : DEFAULT_VARIANT;
}

/**
 * `:::info ` at the start of a block, for all five variants.
 *
 * Docusaurus, Obsidian and MkDocs all ship some spelling of this, so it is the
 * gesture people already have in their fingers — which is why it earns its
 * place as the *input* even though it was rejected as the *storage* form.
 */
export const CALLOUT_INPUT_RULE = new RegExp(`^:::(${CALLOUT_VARIANTS.join('|')})\\s$`);

export interface CalloutOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selection in a callout of `variant`. */
      setCallout: (variant?: CalloutVariant) => ReturnType;
      /** Wrap the selection, or unwrap it when it is already this variant. */
      toggleCallout: (variant?: CalloutVariant) => ReturnType;
      /** Lift the selection out of its callout, keeping the blocks. */
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create<CalloutOptions>({
  name: CALLOUT_NODE_NAME,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  group: 'block',

  content: 'block+',

  // As on `blockquote`: replacing the whole selection inside a panel should
  // leave the panel standing rather than deleting it out from under the caret.
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: DEFAULT_VARIANT,
        parseHTML: (element) => normalizeCalloutVariant(element.getAttribute('data-variant')),
        renderHTML: (attributes) => ({
          'data-variant': normalizeCalloutVariant(attributes.variant),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // No class names and no colours. The variant is the only thing this library
    // knows; which yellow a warning is belongs to the app's theme tokens, and
    // baking a palette in here would make every consumer fight it.
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': 'callout' }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (variant) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { variant: normalizeCalloutVariant(variant) }),

      toggleCallout:
        (variant) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { variant: normalizeCalloutVariant(variant) }),

      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: CALLOUT_INPUT_RULE,
        type: this.type,
        getAttributes: (match) => ({ variant: normalizeCalloutVariant(match[1]) }),
      }),
    ];
  },
});
