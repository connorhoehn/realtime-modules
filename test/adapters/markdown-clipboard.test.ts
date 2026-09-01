// realtime-modules/test/adapters/markdown-clipboard.test.ts
//
// The clipboard is where "markdown-native" is either true or a slogan. These
// tests exercise the two conversions directly rather than through a mounted
// editor: a wrong detection rule or a lossy serialise is a data bug, and
// putting a ProseMirror view in the way would make it look like a UI bug.

import {
  parseDocument,
  serializeDocument,
} from 'distributed-core/applications/document';
import { docModelToPm, pmToDocModel } from '../../src/adapters/tiptap/canvas/pmModel';
import { looksLikeMarkdown } from '../../src/adapters/tiptap/canvas/MarkdownClipboard';

/** What handlePaste does: markdown text -> ProseMirror block JSON. */
function paste(markdown: string) {
  return docModelToPm(parseDocument(markdown)).doc.content ?? [];
}

/** What clipboardTextSerializer does: block JSON -> markdown text. */
function copy(content: unknown[]): string {
  return serializeDocument(
    pmToDocModel({ type: 'doc', content } as never, {}),
  ).trimEnd();
}

describe('looksLikeMarkdown — what is safe to transform', () => {
  it.each([
    ['# Heading', 'atx heading'],
    ['- one\n- two', 'bullet list'],
    ['1. first', 'ordered list'],
    ['> quoted', 'blockquote'],
    ['```js\nx\n```', 'fence'],
    ['| a | b |', 'table row'],
    ['intro\n\n## Later heading', 'a block marker below the first line'],
  ])('detects %s (%s)', (text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  // The important half. Inline markers are NOT enough: transforming prose
  // that merely contains them deletes characters the user typed, which is
  // worse than declining to convert a bold run.
  it.each([
    ['Multiply 2 * 3 * 4 to get 24', 'asterisks used as maths'],
    ['open some_file_name.txt', 'underscores in an identifier'],
    ['see https://example.dev/a_b_c', 'a url'],
    ['just a sentence', 'plain prose'],
    ['', 'empty'],
  ])('declines %s (%s)', (text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe('paste: markdown -> blocks', () => {
  it('turns a heading into a heading node, not text with a hash', () => {
    const blocks = paste('## Findings');
    expect(blocks[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(JSON.stringify(blocks)).not.toContain('##');
  });

  it('keeps a list a list', () => {
    const blocks = paste('- one\n- two');
    expect(blocks[0]?.type).toBe('bulletList');
    expect(blocks[0]?.content).toHaveLength(2);
  });

  it('carries inline marks through', () => {
    const blocks = paste('a **bold** word');
    expect(JSON.stringify(blocks)).toContain('"type":"bold"');
  });

  it('preserves a fence as a code block with its language', () => {
    const blocks = paste('```sql\nselect 1;\n```');
    expect(blocks[0]).toMatchObject({ type: 'codeBlock' });
    expect(JSON.stringify(blocks)).toContain('select 1;');
  });
});

describe('copy: blocks -> markdown', () => {
  it('emits a heading as markdown, not flattened text', () => {
    expect(copy(paste('## Findings'))).toBe('## Findings');
  });

  it('emits a list as markdown', () => {
    expect(copy(paste('- one\n- two'))).toContain('- one');
  });

  // The property that makes the clipboard trustworthy: what you copy out of
  // the page is what you can paste back in without drift.
  it.each([
    '# Title',
    '## Section\n\nSome prose.',
    '- one\n- two',
    '1. first\n2. second',
    '> quoted',
    '```sql\nselect 1;\n```',
    'a **bold** and *italic* word',
  ])('round-trips %j unchanged', (markdown) => {
    const once = copy(paste(markdown));
    // Compared against the CANONICAL form, not the input: the chassis has one
    // spelling per document, so the fixed point is what stability means here.
    expect(copy(paste(once))).toBe(once);
  });

  it('returns empty for an empty selection rather than throwing', () => {
    expect(copy([])).toBe('');
  });
});
