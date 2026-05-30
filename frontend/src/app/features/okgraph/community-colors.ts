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
