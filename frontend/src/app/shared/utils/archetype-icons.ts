const ARCHETYPE_ICON_MAP: Record<string, string> = {
  'The Innovator': 'emoji_objects',
  'The Synthesizer': 'summarize',
  'The Combiner': 'layers',
  'The Architect': 'schema',
  'The Translator': 'transform',
  'The Evaluator': 'fact_check',
  'The Analyst': 'analytics',
  'The Resource Creator': 'storage'
};

export function getArchetypeIcon(archetype?: string | null): string {
  if (!archetype) return 'layers';
  return ARCHETYPE_ICON_MAP[archetype] || 'layers';
}
