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
}

export interface CombinedUpdateStatus {
  app: UpdateInfo | null;
  appError: string | null;
  engine: LlamaCppStatus | null;
  engineError: string | null;
}

export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^[^\d]*/, '')
      .split(/[-+.]/)
      .map(part => {
        const num = parseInt(part, 10);
        return isNaN(num) ? 0 : num;
      });

  const p1 = parse(v1);
  const p2 = parse(v2);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const n1 = p1[i] ?? 0;
    const n2 = p2[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

export async function checkGithubRelease(
  currentVersion: string = APP_VERSION,
  repo: string = DEFAULT_REPO,
): Promise<UpdateInfo> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'PocketPal16-Updater',
    },
  });

  if (response.status === 404) {
    throw new Error(`No releases published on GitHub repository ${repo} yet.`);
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API error (${response.status}): ${response.statusText}`,
    );
  }

  const data = await response.json();
  const tagName = String(data.tag_name ?? '');
  const latestVersion = tagName.replace(/^[^\d]*/, '') || tagName;
  const assets: Array<{name?: string; browser_download_url?: string}> =
    Array.isArray(data.assets) ? data.assets : [];

  const ipaAsset = assets.find(asset =>
    asset.name?.toLowerCase().endsWith('.ipa'),
  );

  const downloadUrl = ipaAsset?.browser_download_url ?? '';
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
  const url = `https://api.github.com/repos/ggml-org/llama.cpp/compare/${pinnedCommit}...master`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'PocketPal16-Updater',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to query llama.cpp upstream: HTTP ${response.status}`,
    );
  }

  const data = await response.json();
  const aheadBy = Number(data.ahead_by ?? 0);
  const commits: Array<{
    sha?: string;
    commit?: {message?: string; author?: {date?: string}};
  }> = Array.isArray(data.commits) ? data.commits : [];

  const latest = commits.length > 0 ? commits[commits.length - 1] : undefined;
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
