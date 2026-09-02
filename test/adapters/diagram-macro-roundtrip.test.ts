// realtime-modules/test/adapters/diagram-macro-roundtrip.test.ts
//
// An embedded diagram is a `macro:diagram` fence carrying a REFERENCE:
//
//     ```macro:diagram
//     id: 6f9a8e2c-4b1d-4f0a-9c3e-7b2d5a1f8e04
//     ```
//
// The elements themselves live in the page's Y.Doc under `excalidraw:<id>`,
// where `ExcalidrawYjsBinding` puts them. The argument for that split is
// written out in `ui-components/src/components/diagram/macro.ts`; this file is
// the half of it that has to be PROVEN rather than argued — that the block
// survives a markdown round trip.
//
// ## Why there is no `diagram` node in this package
//
// A callout got its own ProseMirror node and a mapping in `pmModel.ts`. A
// diagram deliberately did not, and this file is what makes that decision
// checkable: the diagram macro round-trips through the GENERIC macro path, with
// no case of its own anywhere in the conversion. That is the property
// MACRO-MARKDOWN.md calls the most important one a shared document format has —
// a client that has never heard of diagrams preserves the block verbatim
// instead of dropping it, because to the conversion it is simply a macro. A
// dedicated node type would have emitted a ProseMirror node such a client has
// no schema entry for, and `Node.fromJSON` throws rather than degrades.
//
// ## The drift guard
//
// `ui-components` writes the macro body itself (`diagramMacroText`), because
// `./diagram` must stay importable by an app with no chassis dependency. That
// is a second writer of one format, so the first test below pins the chassis
// serialiser's output for this payload. If the chassis ever changes how it
// dumps a one-key mapping, it fails HERE — loudly, in the package that owns the
// format — rather than silently in a renderer that then cannot find its own
// elements.

import { parseDocument, serializeDocument } from 'distributed-core/applications/document';
import { docModelToPm, macroTextFromData, pmToDocModel } from '../../src/adapters/tiptap/canvas';

const DIAGRAM_MACRO_NAME = 'diagram';
const ID = '6f9a8e2c-4b1d-4f0a-9c3e-7b2d5a1f8e04';

/** markdown → DocModel → ProseMirror → DocModel → markdown */
function throughEditor(markdown: string): string {
  const model = parseDocument(markdown);
  const { doc } = docModelToPm(model);
  return serializeDocument(pmToDocModel(doc, model.frontMatter));
}

function expectFixedPoint(markdown: string): void {
  // Guard the guard, as `callout-roundtrip.test.ts` does: if the chassis does
  // not already consider this input canonical, the assertion below would prove
  // nothing about the editor leg.
  expect(serializeDocument(parseDocument(markdown))).toBe(markdown);
  expect(throughEditor(markdown)).toBe(markdown);
}

const diagramMarkdown = (id: string): string =>
  ['```macro:diagram', `id: ${id}`, '```', ''].join('\n');

describe('diagram macro: the body ui-components writes', () => {
  it('is byte-identical to what the chassis serialiser produces', () => {
    // `diagramMacroText(id)` in ui-components is exactly this string. A UUID is
    // five hex groups, so YAML can never read it as a date or a sexagesimal and
    // js-yaml leaves it unquoted — which is what makes a hand-written one-line
    // body safe.
    expect(macroTextFromData(DIAGRAM_MACRO_NAME, { id: ID })).toBe(`id: ${ID}`);
  });

  it('serialises to the fence the renderer keys on', () => {
    expect(
      serializeDocument({
        frontMatter: {},
        content: [{ type: 'macro', name: DIAGRAM_MACRO_NAME, data: { id: ID } }],
      }),
    ).toBe(diagramMarkdown(ID));
  });
});

describe('diagram macro round trip: markdown ⇄ ProseMirror', () => {
  it('is a fixed point on its own', () => {
    expectFixedPoint(diagramMarkdown(ID));
  });

  it('is a fixed point sitting between ordinary blocks', () => {
    expectFixedPoint(
      [
        '# Cell routing',
        '',
        'The hash ring, before the fallback lands:',
        '',
        '```macro:diagram',
        `id: ${ID}`,
        '```',
        '',
        'Every cell owns a contiguous arc.',
        '',
      ].join('\n'),
    );
  });

  it('is a fixed point for two diagrams on one page', () => {
    // Two blocks, two ids, one document — the case the `blockId` namespacing in
    // `ExcalidrawYjsBinding` exists for. If the conversion ever merged or
    // reordered macros this is where it would show.
    const second = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expectFixedPoint(
      [
        '```macro:diagram',
        `id: ${ID}`,
        '```',
        '',
        'and then',
        '',
        '```macro:diagram',
        `id: ${second}`,
        '```',
        '',
      ].join('\n'),
    );
  });

  it('reaches ProseMirror as an ordinary macro node, with no diagram case anywhere', () => {
    // The shape assertion behind the byte assertion. A conversion that quietly
    // introduced a `diagram` node type would still serialise to the same
    // markdown here, and would blank the page of any client whose schema lacks
    // it.
    const { doc, unsupported } = docModelToPm(parseDocument(diagramMarkdown(ID)));
    expect(unsupported).toEqual([]);
    expect(doc.content).toHaveLength(1);

    const block = doc.content![0]!;
    expect(block.type).toBe('macro');
    expect(block.attrs).toEqual({ macroName: DIAGRAM_MACRO_NAME });
    expect(block.content).toEqual([{ type: 'text', text: `id: ${ID}` }]);
  });

  it('comes back out of ProseMirror as a macro block, not as a code fence', () => {
    const model = pmToDocModel({
      type: 'doc',
      content: [
        {
          type: 'macro',
          attrs: { macroName: DIAGRAM_MACRO_NAME },
          content: [{ type: 'text', text: `id: ${ID}` }],
        },
      ],
    });
    expect(model.content).toEqual([
      { type: 'macro', name: DIAGRAM_MACRO_NAME, data: { id: ID } },
    ]);
  });

  it('keeps a body a merge damaged, rather than dropping the block', () => {
    // `pmBlocksToModel` degrades an unparseable macro to a fenced code block
    // whose info string still says `macro:diagram`, so the user's bytes reach
    // the file and the renderer can show them back. Nothing is invented and
    // nothing is lost — the renderer's "no longer names a diagram" state is the
    // other end of this path.
    const model = pmToDocModel({
      type: 'doc',
      content: [
        {
          type: 'macro',
          attrs: { macroName: DIAGRAM_MACRO_NAME },
          content: [{ type: 'text', text: 'id: [unclosed' }],
        },
      ],
    });
    const md = serializeDocument(model);
    expect(md).toContain('macro:diagram');
    expect(md).toContain('id: [unclosed');
  });
});
