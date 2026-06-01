import { describe, it, expect } from 'vitest';
import { blendColors } from './community-colors';

describe('blendColors', () => {
  it('mixes two colours at the midpoint by default', () => {
    // #000000 + #ffffff -> #7f7f7f (round(255 * 0.5) = 128 -> but mix is x+(y-x)*0.5)
    expect(blendColors('#000000', '#ffffff')).toBe('#808080');
  });

  it('honours the A→B weight', () => {
    expect(blendColors('#000000', '#ffffff', 0)).toBe('#000000');
    expect(blendColors('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends two distinct cluster hues channelwise', () => {
    // #2563eb (37,99,235) + #dc2626 (220,38,38)
    //   r: 37+(220-37)/2  = 128.5 -> 129 (0x81)
    //   g: 99+(38-99)/2   = 68.5  -> 69  (0x45)
    //   b: 235+(38-235)/2 = 136.5 -> 137 (0x89)
    expect(blendColors('#2563eb', '#dc2626')).toBe('#814589');
  });

  it('is symmetric at the midpoint', () => {
    expect(blendColors('#059669', '#d97706')).toBe(blendColors('#d97706', '#059669'));
  });
});
