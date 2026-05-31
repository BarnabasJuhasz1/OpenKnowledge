/**
 * Cluster colour palette — kept identical to the Cit-Graph's COMMUNITY_COLORS so
 * the OK-Graph blobs match the cit-graph community colours. Colour for a cluster
 * id `c` is `COMMUNITY_COLORS[c % COMMUNITY_COLORS.length]`.
 */
export const COMMUNITY_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
  '#db2777', '#0891b2', '#65a30d', '#ea580c', '#4f46e5',
  '#be123c', '#0d9488', '#b45309', '#7e22ce', '#c2410c',
];

export function clusterColor(id: number): string {
  const n = COMMUNITY_COLORS.length;
  return COMMUNITY_COLORS[((id % n) + n) % n];
}

/** Neutral grey reserved for the "Miscellaneous" cluster — the catch-all that
 *  holds every disconnected node. Deliberately outside COMMUNITY_COLORS so it
 *  never collides with a real cluster's hue. */
export const MISC_COLOR = '#6b7280';

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const toHex = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');

/** A darker variant. */
export function darken(hex: string, amount = 0.28): string {
  const [r, g, b] = parseHex(hex);
  return `#${toHex(r * (1 - amount))}${toHex(g * (1 - amount))}${toHex(b * (1 - amount))}`;
}

/** A brighter variant (mix toward white) — the higher-contrast highlight on the
 *  dark canvas. */
export function lighten(hex: string, amount = 0.3): string {
  const [r, g, b] = parseHex(hex);
  const f = (c: number) => c + (255 - c) * amount;
  return `#${toHex(f(r))}${toHex(f(g))}${toHex(f(b))}`;
}

/** The colour with an alpha channel, as an rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
