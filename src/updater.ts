import {Linking} from 'react-native';

export const APP_VERSION = '1.19.1';
export const DEFAULT_REPO = 'dusklinux/pocketpal_16';
export const PINNED_LLAMA_CPP_COMMIT =
  'c83f3058b6f876f2f7e6ccbada858b2446860c85';
export const PINNED_LLAMA_CPP_SHORT = 'c83f3058b6f8';
export const PINNED_LLAMA_CPP_DATE = '2026-10-11';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  downloadUrl: string;
  releaseUrl: string;
}

export interface LlamaCppStatus {
  pinnedCommit: string;
  pinnedDate: string;
  latestCommit: string;
  commitsAhead: number;
  latestDate: string;
  latestMessage: string;
  status: string;
}

export interface CombinedUpdateStatus {
  app: UpdateInfo | null;
  appError: string | null;
  engine: LlamaCppStatus | null;
  engineError: string | null;
}

export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string) => {
    const match =
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/.exec(
        v,
      );
    if (!match) throw new Error(`Invalid release version: ${v}`);
    return {core: match.slice(1, 4).map(Number), pre: match[4]?.split('.')};
  };
  const p1 = parse(v1),
    p2 = parse(v2);
  for (let i = 0; i < 3; i++) {
    const n1 = p1.core[i];
    const n2 = p2.core[i];
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  if (!p1.pre || !p2.pre) return p1.pre ? -1 : p2.pre ? 1 : 0;
  for (let i = 0; i < Math.max(p1.pre.length, p2.pre.length); i++) {
    const a = p1.pre[i],
      b = p2.pre[i];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const na = /^\d+$/.test(a),
      nb = /^\d+$/.test(b);
    if (na && nb) return Number(a) > Number(b) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

async function githubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PocketPal16-Updater',
      },
    });
    if (!response.ok)
      throw new Error(`GitHub request failed (HTTP ${response.status}).`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkGithubRelease(
  currentVersion: string = APP_VERSION,
  repo: string = DEFAULT_REPO,
): Promise<UpdateInfo> {
  const data = await githubJson<{
    tag_name?: string;
    name?: string;
    body?: string;
    published_at?: string;
    html_url?: string;
    assets?: Array<{name?: string; browser_download_url?: string}>;
  }>(`https://api.github.com/repos/${repo}/releases/latest`);
  const tagName = String(data.tag_name ?? '');
  const latestVersion = tagName.replace(/^[^\d]*/, '') || tagName;
  const assets: Array<{name?: string; browser_download_url?: string}> =
    Array.isArray(data.assets) ? data.assets : [];

  // Prefer the full native IPA: a JS-only artifact cannot carry a new engine.
  const ipaAsset = assets.find(asset => asset.name === 'PocketPal16.ipa');

  const downloadUrl = ipaAsset?.browser_download_url ?? '';
  if (!downloadUrl)
    throw new Error('Release has no PocketPal16.ipa native build.');
  const hasUpdate = Boolean(
    downloadUrl && compareSemver(latestVersion, currentVersion) > 0,
  );

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    releaseName: String(data.name || tagName),
    releaseNotes: String(data.body ?? '').trim(),
    publishedAt: String(data.published_at ?? ''),
    downloadUrl,
    releaseUrl: String(data.html_url ?? `https://github.com/${repo}/releases`),
  };
}

export async function checkLlamaCppStatus(
  pinnedCommit: string = PINNED_LLAMA_CPP_COMMIT,
): Promise<LlamaCppStatus> {
  const latest = await githubJson<{
    sha: string;
    commit?: {author?: {date?: string}; message?: string};
  }>('https://api.github.com/repos/ggml-org/llama.cpp/commits/master');
  const url = `https://api.github.com/repos/ggml-org/llama.cpp/compare/${pinnedCommit}...${latest.sha}?per_page=1`;
  const data = await githubJson<{ahead_by?: number; status?: string}>(url);
  const aheadBy = Number(data.ahead_by ?? 0);
  // Resolve master first: compare.commits is paginated and may omit the head.
  const latestCommit = latest?.sha ? latest.sha.slice(0, 8) : 'master';
  const latestDate = latest?.commit?.author?.date
    ? latest.commit.author.date.slice(0, 10)
    : '';
  const latestMessage = latest?.commit?.message
    ? latest.commit.message.split('\n')[0]
    : '';

  return {
    pinnedCommit: pinnedCommit.slice(0, 8),
    pinnedDate: PINNED_LLAMA_CPP_DATE,
    latestCommit,
    commitsAhead: aheadBy,
    latestDate,
    latestMessage,
    status: String(data.status ?? 'unknown'),
  };
}

export async function checkAllUpdates(
  currentVersion: string = APP_VERSION,
  repo: string = DEFAULT_REPO,
  pinnedCommit: string = PINNED_LLAMA_CPP_COMMIT,
): Promise<CombinedUpdateStatus> {
  const [appResult, engineResult] = await Promise.allSettled([
    checkGithubRelease(currentVersion, repo),
    checkLlamaCppStatus(pinnedCommit),
  ]);

  return {
    app: appResult.status === 'fulfilled' ? appResult.value : null,
    appError:
      appResult.status === 'rejected'
        ? appResult.reason instanceof Error
          ? appResult.reason.message
          : String(appResult.reason)
        : null,
    engine: engineResult.status === 'fulfilled' ? engineResult.value : null,
    engineError:
      engineResult.status === 'rejected'
        ? engineResult.reason instanceof Error
          ? engineResult.reason.message
          : String(engineResult.reason)
        : null,
  };
}

export async function installWithTrollStore(ipaUrl: string): Promise<void> {
  const trimmed = ipaUrl.trim();
  if (!trimmed) {
    throw new Error('Please specify a valid IPA URL.');
  }

  const trollStoreUrl = `apple-magnifier://install?url=${encodeURIComponent(
    trimmed,
  )}`;

  try {
    const canOpen = await Linking.canOpenURL('apple-magnifier://');
    if (canOpen) {
      await Linking.openURL(trollStoreUrl);
      return;
    }
  } catch {
    // If scheme checking throws, attempt direct open
  }

  try {
    await Linking.openURL(trollStoreUrl);
  } catch {
    // Fallback to opening the direct URL in Safari
    await Linking.openURL(trimmed);
  }
}
