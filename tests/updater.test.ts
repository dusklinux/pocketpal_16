jest.mock('react-native', () => ({
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
}));

import {
  compareSemver,
  checkGithubRelease,
  checkLlamaCppStatus,
  checkAllUpdates,
  installWithTrollStore,
} from '../src/updater';
import {Linking} from 'react-native';

describe('updater module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('compareSemver correctly identifies version order', () => {
    expect(compareSemver('1.20.0', '1.19.1')).toBeGreaterThan(0);
    expect(compareSemver('v1.19.2', '1.19.1')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.19.1', '1.19.1')).toBe(0);
    expect(compareSemver('v1.19.1', '1.19.1')).toBe(0);
    expect(compareSemver('1.19.0', '1.19.1')).toBeLessThan(0);
    expect(compareSemver('1.18.9', '1.19.1')).toBeLessThan(0);
  });

  test('checkGithubRelease identifies available IPA update', async () => {
    const mockRelease = {
      tag_name: 'v1.20.0',
      name: 'PocketPal 16 v1.20.0',
      body: 'Performance improvements and bug fixes.',
      published_at: '2026-10-16T12:00:00Z',
      html_url:
        'https://github.com/dusklinux/pocketpal_16/releases/tag/v1.20.0',
      assets: [
        {
          name: 'PocketPal16.ipa',
          browser_download_url:
            'https://github.com/dusklinux/pocketpal_16/releases/download/v1.20.0/PocketPal16.ipa',
        },
      ],
    };

    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockRelease,
    });

    const info = await checkGithubRelease('1.19.1');
    expect(info.hasUpdate).toBe(true);
    expect(info.latestVersion).toBe('1.20.0');
    expect(info.downloadUrl).toBe(
      'https://github.com/dusklinux/pocketpal_16/releases/download/v1.20.0/PocketPal16.ipa',
    );
    expect(info.releaseNotes).toBe('Performance improvements and bug fixes.');
  });

  test('checkGithubRelease detects when app is already up to date', async () => {
    const mockRelease = {
      tag_name: 'v1.19.1',
      name: 'PocketPal 16 v1.19.1',
      body: 'Current version release.',
      assets: [
        {
          name: 'PocketPal16.ipa',
          browser_download_url: 'https://example.com/PocketPal16.ipa',
        },
      ],
    };

    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockRelease,
    });

    const info = await checkGithubRelease('1.19.1');
    expect(info.hasUpdate).toBe(false);
    expect(info.latestVersion).toBe('1.19.1');
  });

  test('checkLlamaCppStatus queries compare endpoint and reports commits ahead', async () => {
    const mockCompare = {
      ahead_by: 140,
      commits: [
        {
          sha: '2a667032abcdef',
          commit: {
            author: {date: '2026-10-16T10:00:00Z'},
            message: 'convert : respect Mistral format',
          },
        },
      ],
    };

    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockCompare,
    });

    const status = await checkLlamaCppStatus(
      'c83f3058b6f876f2f7e6ccbada858b2446860c85',
    );
    expect(status.commitsAhead).toBe(140);
    expect(status.pinnedCommit).toBe('c83f3058');
    expect(status.latestCommit).toBe('2a667032');
    expect(status.latestDate).toBe('2026-10-16');
    expect(status.latestMessage).toBe('convert : respect Mistral format');
  });

  test('checkAllUpdates combines app and engine results safely', async () => {
    (globalThis as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('llama.cpp')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ahead_by: 5, commits: [{sha: '12345678'}]}),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
    });

    const combined = await checkAllUpdates('1.19.1');
    expect(combined.engine?.commitsAhead).toBe(5);
    expect(combined.app).toBeNull();
    expect(combined.appError).toContain('No releases published');
  });

  test('installWithTrollStore opens TrollStore URL scheme', async () => {
    const ipaUrl = 'https://example.com/PocketPal16.ipa';
    (Linking.canOpenURL as jest.Mock).mockResolvedValue(true);
    (Linking.openURL as jest.Mock).mockResolvedValue(true);

    await installWithTrollStore(ipaUrl);

    expect(Linking.canOpenURL).toHaveBeenCalledWith('apple-magnifier://');
    expect(Linking.openURL).toHaveBeenCalledWith(
      `apple-magnifier://install?url=${encodeURIComponent(ipaUrl)}`,
    );
  });

  test('installWithTrollStore throws on empty URL', async () => {
    await expect(installWithTrollStore('')).rejects.toThrow(
      'Please specify a valid IPA URL.',
    );
  });
});
