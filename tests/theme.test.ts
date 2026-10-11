import {palettes, resolveTheme} from '../src/theme';
test('automatic appearance follows the system; explicit choices override it', () => {
  expect(resolveTheme('system', 'dark')).toBe('dark');
  expect(resolveTheme('system', null)).toBe('light');
  expect(resolveTheme('light', 'dark')).toBe('light');
  expect(resolveTheme('dark', 'light')).toBe('dark');
});
test('text and control colors are readable on both chat backgrounds', () => {
  const luminance = (hex: string) => {
    const rgb = hex
      .slice(1)
      .match(/../g)!
      .map(x => parseInt(x, 16) / 255)
      .map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const contrast = (a: string, b: string) => {
    const x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const colors of Object.values(palettes)) {
    for (const background of [
      colors.background,
      colors.user,
      colors.assistant,
    ]) {
      expect(contrast(colors.text, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accent, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrast(colors.error, colors.errorBackground),
    ).toBeGreaterThanOrEqual(4.5);
  }
});
