// realtime-modules/src/client/media-effects/backgrounds.ts
//
// Built-in virtual backgrounds for the 'image' background mode.
//
// The reference implementation pulled Unsplash photos at runtime; this
// library bans external fetches (CSP-locked consumers, air-gapped dev), so
// the built-ins are generated locally as data: URIs instead — tasteful
// two-stop linear gradients rendered once and memoized. drawImage() accepts
// data-URI images exactly like remote ones, so the engine's cover-fit path
// needs no special casing. Consumers with real photography pass their own
// BackgroundOption[] to useMediaEffects.
//
// SSR safety: nothing here touches `document` at module load. The first
// getBuiltInBackgrounds() call in a browser renders the gradients; on a
// server it returns [] (there is nothing to composite server-side anyway).

export interface BackgroundOption {
  id: string;
  label: string;
  /** Image URL — for built-ins, a data: URI. */
  url: string;
}

const WIDTH = 1280;
const HEIGHT = 720;

interface GradientSpec {
  id: string;
  label: string;
  from: string;
  to: string;
}

const GRADIENTS: GradientSpec[] = [
  { id: 'dusk',   label: 'Dusk',   from: '#2b2150', to: '#d97a5a' },
  { id: 'ocean',  label: 'Ocean',  from: '#0b3550', to: '#3ba9a0' },
  { id: 'forest', label: 'Forest', from: '#12331f', to: '#7aa66a' },
  { id: 'slate',  label: 'Slate',  from: '#22262e', to: '#5c6672' },
];

/** Diagonal gradient via canvas → JPEG data URI. Falls back to an SVG data
 *  URI when Canvas 2D is unavailable (e.g. jsdom without the `canvas`
 *  addon) — SVG needs no raster backend and drawImage handles it fine. */
function renderGradient(spec: GradientSpec): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
      grad.addColorStop(0, spec.from);
      grad.addColorStop(1, spec.to);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      // JPEG: smooth gradients compress far better than PNG here.
      return canvas.toDataURL('image/jpeg', 0.9);
    }
  } catch {
    // fall through to SVG
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${spec.from}"/><stop offset="1" stop-color="${spec.to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let cache: BackgroundOption[] | null = null;

/** Memoized: gradients render once per page, then the same array (and the
 *  same data-URI strings, so persisted urls keep matching) is returned. */
export function getBuiltInBackgrounds(): BackgroundOption[] {
  if (cache) return cache;
  if (typeof document === 'undefined') return [];
  cache = GRADIENTS.map((g) => ({ id: g.id, label: g.label, url: renderGradient(g) }));
  return cache;
}
