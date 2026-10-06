// The vendored deck engine (docs/assessment-deck-goal.md decision 1): each
// file names its platform-api source commit, the .pptx is a real OOXML zip,
// and the preview has one SVG per slide plus the generated Sources slide.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import JSZip from 'jszip';
import { validateDeckSpec, type DeckSpec } from '../../src/deck/DeckSpec';
import { renderPptx, PPTX_CONTENT_TYPE } from '../../src/deck/renderPptx';
import { renderAllSlideSvgs } from '../../src/deck/renderSlideSvg';
import { renderDeckPreview } from '../../src/deck/preview';
import { hidePptxNodeDetection } from './pptxTestEnv';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());

const SPEC: DeckSpec = {
  title: 'Engine check',
  subtitle: 'Vendored renderer',
  theme: 'plain',
  slides: [
    { id: 'title', layout: 'title', title: 'Engine check', bullets: ['Cohort: General'], sources: [{ documentId: 'assessment:TEAM-001:all', title: 'Scorecard' }] },
    { id: 'overview', layout: 'chart', title: 'Overview', sources: [{ documentId: 'assessment:TEAM-001:all', title: 'Scorecard' }],
      chart: { kind: 'bar', labels: ['CI', 'CD'], series: [{ name: 'Verified', values: [2, 3] }, { name: 'Target', values: [3, 3] }] } },
    { id: 'dim-1', layout: 'two-column', title: 'Continuous Integration', columns: [['Verified Level 2'], ['“quoted”']],
      sources: [{ documentId: 'assessment:TEAM-001:1', title: 'Dimension 1' }, { documentId: 'EV-1', title: 'Evidence EV-1' }] },
  ],
};

describe('vendored deck engine', () => {
  it('every vendored file names platform-api src/deck at 34d17f7', () => {
    for (const file of ['DeckSpec', 'renderPptx', 'renderSlideSvg', 'theme', 'deckConstraints', 'preview']) {
      const head = readFileSync(join(__dirname, '..', '..', 'src', 'deck', `${file}.ts`), 'utf8').split('\n').slice(0, 3).join('\n');
      expect({ file, ok: head.includes(`platform-api src/deck/${file}.ts at commit 34d17f7`) }).toEqual({ file, ok: true });
    }
  });

  it('renderPptx writes a zip whose [Content_Types].xml declares presentation parts', async () => {
    expect(validateDeckSpec(SPEC).ok).toBe(true);
    const bytes = await renderPptx(SPEC);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const zip = await JSZip.loadAsync(bytes);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml');
    expect(types).toContain('application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
    // The deck's three slides plus the generated Sources slide.
    expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(SPEC.slides.length + 1);
    expect(PPTX_CONTENT_TYPE).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('the SVG preview count is the spec slides plus the generated Sources slide', () => {
    const svgs = renderAllSlideSvgs(SPEC);
    expect(svgs).toHaveLength(SPEC.slides.length + 1);
    for (const svg of svgs) expect(svg.startsWith('<svg')).toBe(true);
    const preview = renderDeckPreview(SPEC);
    expect(preview.slides.map((s) => s.id)).toEqual(['title', 'overview', 'dim-1', 'sources']);
  });

  it('slide XML matches the vendored engine byte for byte (golden digest)', async () => {
    const zip = await JSZip.loadAsync(await renderPptx(SPEC));
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
    const h = createHash('sha256');
    for (const n of names) h.update(n).update(await zip.file(n)!.async('string'));
    expect({ slides: names.length, sha256: h.digest('hex') }).toEqual({ slides: 4, sha256: 'd430349facda84a501f767274018bc473e03ed5cfb14f76cc9172ff824a5f293' });
  });
});
