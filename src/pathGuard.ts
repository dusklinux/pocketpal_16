export const GGUF_EXTENSION = /\.gguf$/i;
const MAX_STEM_LENGTH = 180;
const MODELS_MARKER = '/Documents/models/';

export function hasControlCharacter(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function removeControlCharacters(str: string): string {
  let res = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) {
      continue;
    }
    res += str[i];
  }
  return res;
}

export function isSafePathSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !hasControlCharacter(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.')
  );
}

export function isModelFilePath(path: string, modelDir: string): boolean {
  const prefix = modelDir.endsWith('/') ? modelDir : `${modelDir}/`;
  if (!path.startsWith(prefix)) {
    return false;
  }
  const segment = path.slice(prefix.length);
  return isSafePathSegment(segment) && GGUF_EXTENSION.test(segment);
}

export function sanitizeModelFilename(rawName: string): string {
  const cleaned = removeControlCharacters(rawName)
    .replace(/[/\\]/g, '_')
    .trim()
    .replace(/^\.+/, '');

  if (!GGUF_EXTENSION.test(cleaned)) {
    throw new Error('Choose a GGUF model file.');
  }

  const stem = cleaned
    .slice(0, -5)
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_STEM_LENGTH)
    .trim();

  if (!stem) {
    throw new Error('Choose a valid GGUF model filename.');
  }

  const ext = cleaned.slice(-5);
  return `${stem}${ext}`;
}

export function safeDecodeUriPath(uri: string): string {
  const stripped = uri.replace(/^file:\/\//i, '');
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

export function rebaseModelPath(rawPath: string, modelDir: string): string {
  if (typeof rawPath !== 'string') {
    return '';
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }
  const markerIdx = trimmed.lastIndexOf(MODELS_MARKER);
  if (markerIdx !== -1) {
    const remainder = trimmed.slice(markerIdx + MODELS_MARKER.length);
    if (isSafePathSegment(remainder) && GGUF_EXTENSION.test(remainder)) {
      return `${modelDir}/${remainder}`;
    }
    return '';
  }
  if (isModelFilePath(trimmed, modelDir)) {
    return trimmed;
  }
  return '';
}
