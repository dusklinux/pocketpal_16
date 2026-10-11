export type ThemeMode = 'system' | 'light' | 'dark';
export const palettes = {
  light: {
    background: '#ffffff',
    text: '#171717',
    secondary: '#505050',
    border: '#b0b0b0',
    user: '#eaf1ff',
    assistant: '#f2f2f2',
    error: '#a00000',
    errorBackground: '#fff0f0',
    accent: '#0065c8',
    placeholder: '#666666',
  },
  dark: {
    background: '#121212',
    text: '#eeeeee',
    secondary: '#b8b8b8',
    border: '#656565',
    user: '#1c304c',
    assistant: '#242424',
    error: '#ffaaaa',
    errorBackground: '#421f1f',
    accent: '#80baff',
    placeholder: '#a0a0a0',
  },
} as const;
export type Palette = (typeof palettes)[keyof typeof palettes];
export function resolveTheme(
  mode: ThemeMode,
  system: string | null | undefined,
): 'light' | 'dark' {
  return mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
}
