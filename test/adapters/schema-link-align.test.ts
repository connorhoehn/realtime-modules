// realtime-modules/test/adapters/schema-link-align.test.ts
//
// The `link` mark and the `textAlign` extension, tested through their extension
// definitions rather than a mounted editor.
//
// No ProseMirror view here on purpose. A stored `javascript:` href is a
// script-execution vector for every future READER of the document, so the check
// that matters is "what does this code do with a hostile string", and putting an
// editor in the way would turn a data bug into something that looks like a UI
// bug. `getAttributesFromExtensions` is Tiptap's own resolver, so these
// assertions run against the same attribute specs a real editor would get.

import { getAttributesFromExtensions, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  CanvasLink,
  CANVAS_STARTER_KIT_OPTIONS,
  DANGEROUS_SCHEMES,
  linkHrefFromPastedText,
  linkTagAttributes,
  sanitizeHref,
} from '../../src/adapters/tiptap/canvas/schema/link';
import {
  CanvasTextAlign,
  TEXT_ALIGNMENTS,
  parseTextAlign,
  textAlignStyle,
} from '../../src/adapters/tiptap/canvas/schema/textAlign';

/** A stand-in for the `HTMLElement` an attribute's `parseHTML` receives. */
function fakeElement(attributes: Record<string, string>, style: Record<string, string> = {}) {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    style,
  } as unknown as HTMLElement;
}

function attributeSpec(extension: Parameters<typeof getAttributesFromExtensions>[0][number], type: string, name: string) {
  const found = getAttributesFromExtensions([extension]).find(
    (attribute) => attribute.type === type && attribute.name === name,
  );
  if (!found) throw new Error(`no ${type}.${name} attribute`);
  return found.attribute;
}

describe('CanvasLink — the contract with pmModel', () => {
  it('is named `link`, which is what wrapMark switches on', () => {
    expect(CanvasLink.name).toBe('link');
  });

  it('does not extend onto text typed after it', () => {
    expect(CanvasLink.config.inclusive).toBe(false);
  });

  it('round-trips href and title', () => {
    const href = attributeSpec(CanvasLink, 'link', 'href');
    const title = attributeSpec(CanvasLink, 'link', 'title');
    const element = fakeElement({ href: 'https://example.com/a', title: 'Spec' });

    const parsed = { href: href.parseHTML!(element), title: title.parseHTML!(element) };
    expect(parsed).toEqual({ href: 'https://example.com/a', title: 'Spec' });

    expect(linkTagAttributes(parsed)).toEqual({
      href: 'https://example.com/a',
      title: 'Spec',
      rel: 'noopener noreferrer',
    });
  });

  it('omits title entirely when there is none — an empty title attribute is not the same document', () => {
    expect(linkTagAttributes({ href: 'https://example.com' })).toEqual({
      href: 'https://example.com',
      rel: 'noopener noreferrer',
    });
  });

  it('always renders rel=noopener noreferrer, even for a rejected href', () => {
    expect(linkTagAttributes({ href: 'javascript:alert(1)' }).rel).toBe('noopener noreferrer');
  });
});

describe('CanvasLink — dangerous hrefs are dropped, not rendered', () => {
  // Every entry is a string a browser resolves as script execution. The
  // obfuscated ones are the point: a `startsWith('javascript:')` check passes
  // all four of the last variants while the browser still runs them, because the
  // HTML parser strips whitespace and control characters out of URL attributes
  // before resolving.
  it.each([
    ['javascript:alert(1)', 'the plain form'],
    ['JaVaScRiPt:alert(1)', 'scheme comparison is case-insensitive'],
    ['  javascript:alert(1)', 'leading whitespace is trimmed by the browser'],
    ['java\tscript:alert(1)', 'a tab inside the scheme is ignored by the browser'],
    ['java\nscript:alert(1)', 'so is a newline'],
    ['java\rscript:alert(1)', 'and a carriage return'],
    ['java\0script:alert(1)', 'and a NUL'],
    ['data:text/html,<script>', 'data: carries executable markup'],
    ['data:image/svg+xml;base64,PHN2Zz4=', 'SVG in a data URL runs script too'],
    ['vbscript:msgbox(1)', 'the legacy IE vector'],
    ['VBScript:msgbox(1)', 'in either case'],
  ])('rejects %s (%s)', (href) => {
    expect(sanitizeHref(href)).toBeNull();
    expect(linkTagAttributes({ href })).not.toHaveProperty('href');
  });

  it('never stores a rejected href either — parse drops it before it reaches the Y.Doc', () => {
    const href = attributeSpec(CanvasLink, 'link', 'href');
    expect(href.parseHTML!(fakeElement({ href: 'JaVaScRiPt:alert(1)' }))).toBeNull();
  });

  it('rejects a non-string href rather than coercing it', () => {
    expect(sanitizeHref(undefined)).toBeNull();
    expect(sanitizeHref(null)).toBeNull();
    expect(sanitizeHref('   ')).toBeNull();
  });

  it('names exactly the three schemes it refuses', () => {
    expect(DANGEROUS_SCHEMES).toEqual(['javascript', 'data', 'vbscript']);
  });
});

describe('CanvasLink — safe hrefs are untouched', () => {
  it.each([
    ['https://example.com/docs?q=a:b', 'absolute https, colon in the query'],
    ['http://example.com', 'absolute http'],
    ['/relative/path', 'site-relative'],
    ['./sibling.md', 'document-relative'],
    ['#anchor', 'in-page anchor'],
    ['/docs/a:b', 'a colon after a slash is not a scheme'],
    ['mailto:someone@example.com', 'mailto'],
    ['mention:u1', 'the internal scheme pmModel round-trips mentions through'],
  ])('accepts %s (%s)', (href) => {
    expect(sanitizeHref(href)).toBe(href);
    expect(linkTagAttributes({ href }).href).toBe(href);
  });

  it('trims surrounding whitespace so the stored value is canonical', () => {
    expect(sanitizeHref('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('CanvasLink — pasting a URL over a selection', () => {
  it('links the selection for a bare URL', () => {
    expect(linkHrefFromPastedText('https://example.com/a')).toBe('https://example.com/a');
    expect(linkHrefFromPastedText('  https://example.com/a \n')).toBe('https://example.com/a');
    expect(linkHrefFromPastedText('mailto:someone@example.com')).toBe(
      'mailto:someone@example.com',
    );
  });

  it('pastes normally when the clipboard is prose that merely contains a URL', () => {
    expect(linkHrefFromPastedText('see https://example.com for more')).toBeNull();
    expect(linkHrefFromPastedText('just words')).toBeNull();
    expect(linkHrefFromPastedText('')).toBeNull();
  });

  it('refuses a dangerous scheme on this path too', () => {
    expect(linkHrefFromPastedText('javascript:alert(1)')).toBeNull();
    expect(linkHrefFromPastedText('data:text/html,<script>')).toBeNull();
  });
});

describe('CanvasTextAlign', () => {
  it('adds the attribute to both paragraph and heading', () => {
    const types = getAttributesFromExtensions([CanvasTextAlign])
      .filter((attribute) => attribute.name === 'textAlign')
      .map((attribute) => attribute.type);
    expect(types.sort()).toEqual(['heading', 'paragraph']);
  });

  it('defaults to unset', () => {
    expect(attributeSpec(CanvasTextAlign, 'paragraph', 'textAlign').default).toBeNull();
  });

  it.each(TEXT_ALIGNMENTS)('renders %s as an inline style', (alignment) => {
    const spec = attributeSpec(CanvasTextAlign, 'paragraph', 'textAlign');
    expect(spec.renderHTML!({ textAlign: alignment })).toEqual({
      style: `text-align: ${alignment}`,
    });
  });

  it('renders NO style attribute when unset', () => {
    const paragraph = attributeSpec(CanvasTextAlign, 'paragraph', 'textAlign');
    const heading = attributeSpec(CanvasTextAlign, 'heading', 'textAlign');
    expect(paragraph.renderHTML!({ textAlign: null })).toEqual({});
    expect(heading.renderHTML!({})).toEqual({});
    expect(textAlignStyle(null)).toEqual({});
  });

  it('parses a known alignment off an element and narrows anything else to unset', () => {
    const spec = attributeSpec(CanvasTextAlign, 'paragraph', 'textAlign');
    expect(spec.parseHTML!(fakeElement({}, { textAlign: 'center' }))).toBe('center');
    expect(spec.parseHTML!(fakeElement({}, { textAlign: '-webkit-center' }))).toBeNull();
    expect(spec.parseHTML!(fakeElement({}, { textAlign: '' }))).toBeNull();
    expect(parseTextAlign('start')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coexisting with StarterKit
//
// StarterKit stays (heading, codeBlock, the marks and the lists all come from
// it), and StarterKit v3 bundles its own `link`. Two extensions with one name is
// not an error in Tiptap — it warns and then merges — so "does not collide" has
// to be a measurement, not a claim. These tests are the measurement, in both
// directions: what actually goes wrong, and that the fix actually fixes it.
// ---------------------------------------------------------------------------

describe('CanvasLink vs StarterKit', () => {
  function schemaFor(extensions: Parameters<typeof getSchema>[0]) {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return { schema: getSchema(extensions), warnings: warn.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
    }
  }

  it('really does corrupt the mark when both are registered', () => {
    // Pinned so nobody has to take the hazard on faith. Tiptap keeps ONE node
    // spec but UNIONS the attribute sets, so StarterKit's render-only
    // `target`/`rel`/`class` become attributes of the STORED mark — replicated
    // through the CRDT and written into the ProseMirror JSON — while its
    // autolink and click plugins keep running against it.
    const { schema, warnings } = schemaFor([StarterKit, CanvasLink]);
    expect(warnings.join('\n')).toContain("Duplicate extension names found: ['link']");
    expect(Object.keys(schema.marks.link.spec.attrs!).sort()).toEqual([
      'class',
      'href',
      'rel',
      'target',
      'title',
    ]);
  });

  it('is the only `link` once StarterKit is configured with CANVAS_STARTER_KIT_OPTIONS', () => {
    const { schema, warnings } = schemaFor([
      StarterKit.configure({ ...CANVAS_STARTER_KIT_OPTIONS }),
      CanvasLink,
    ]);
    expect(warnings).toEqual([]);
    // Exactly the two attributes `pmModel.ts`'s `wrapMark` reads, and nothing
    // else — which is also how you can tell whose mark won.
    expect(Object.keys(schema.marks.link.spec.attrs!).sort()).toEqual(['href', 'title']);
    expect(schema.marks.link.spec.inclusive).toBe(false);
  });

  it('keeps everything StarterKit is being kept FOR', () => {
    // The point of deleting `blocks.ts`/`marks.ts`/`lists.ts` was that StarterKit
    // already supplies these under the names `pmModel.ts` switches on. If a
    // future `configure` call turned one off, the round trip would degrade
    // silently rather than fail — so assert the names are present.
    const { schema } = schemaFor([
      StarterKit.configure({ ...CANVAS_STARTER_KIT_OPTIONS }),
      CanvasLink,
    ]);
    for (const node of ['heading', 'paragraph', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'horizontalRule', 'hardBreak']) {
      expect(schema.nodes[node]).toBeDefined();
    }
    for (const mark of ['bold', 'italic', 'strike', 'code']) {
      expect(schema.marks[mark]).toBeDefined();
    }
  });

  it('rejects the schemes a stored href must never carry, including the browser-normalised spellings', () => {
    // The reason this file owns a link mark at all is that the check is a DENY
    // list: `mention:` — the scheme `pmModel.ts` stores every mention under, and
    // the one StarterKit's ALLOW list has no entry for — has to keep working.
    expect(sanitizeHref('mention:user-123')).toBe('mention:user-123');
    expect(sanitizeHref('java\tscript:alert(1)')).toBeNull();
    expect(sanitizeHref('JAVASCRIPT:alert(1)')).toBeNull();
  });
});
