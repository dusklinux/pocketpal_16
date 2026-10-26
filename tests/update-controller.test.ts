import {afterEach} from '@jest/globals';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  LibraryDirectoryPath: '/library',
}));
jest.mock('react-native', () => ({NativeModules: {}, Linking: {}}));

import {
  UpdateController,
  UPDATE_INTERVAL_MS,
  UPDATE_RETRY_MS,
} from '../src/update-controller';
import {
  CombinedUpdateStatus,
  APP_VERSION,
  PINNED_LLAMA_CPP_COMMIT,
} from '../src/updater';

const result: CombinedUpdateStatus = {
  app: {
    hasUpdate: true,
    currentVersion: APP_VERSION,
    latestVersion: '1.20.0',
    releaseName: '',
    releaseNotes: '',
    publishedAt: '',
    downloadUrl: 'https://example.com/PocketPal16.ipa',
    releaseUrl: '',
  },
  appError: null,
  engine: null,
  engineError: null,
};

describe('automatic update scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1800000000000);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function fixture() {
    let saved: string | null = null;
    const store = {
      read: jest.fn(async () => saved),
      write: jest.fn(async (raw: string) => {
        saved = raw;
      }),
    };
    const query = jest.fn(async () => result);
    return {
      store,
      query,
      controller: new UpdateController(store, query, () => Date.now()),
    };
  }

  test('first launch checks once; the next check occurs at exactly 48 hours', async () => {
    const {controller, query} = fixture();
    controller.setActive(true);
    await controller.check();
    expect(query).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    controller.setActive(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('restarting preserves the due time, repository and available installation offer', async () => {
    const {controller, store, query} = fixture();
    await controller.check(true, 'owner/releases');
    const restarted = new UpdateController(store, query, () => Date.now());
    await restarted.check();
    expect(query).toHaveBeenCalledTimes(1);
    expect(restarted.repo).toBe('owner/releases');
    expect(restarted.data?.app?.hasUpdate).toBe(true);
    expect(restarted.nextCheckAt).toBe(controller.nextCheckAt);
  });

  test('background disables the timer; foreground catches up when overdue', async () => {
    const {controller, query} = fixture();
    controller.setActive(true);
    await controller.check();
    controller.setActive(false);
    await jest.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS + 1000);
    expect(query).toHaveBeenCalledTimes(1);
    controller.setActive(true);
    await controller.check();
    expect(query).toHaveBeenCalledTimes(2);
    controller.setActive(false);
  });

  test('manual checks bypass the due time and simultaneous checks share one request', async () => {
    const {controller, query} = fixture();
    const first = controller.check();
    expect(controller.check()).toBe(first);
    await first;
    await controller.check(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('partial network failure retries after one hour, including across restart', async () => {
    const {controller, query, store} = fixture();
    query.mockResolvedValue({...result, app: null, appError: 'Offline'});
    await controller.check();
    expect(controller.nextCheckAt).toBe(Date.now() + UPDATE_RETRY_MS);
    const restarted = new UpdateController(store, query, () => Date.now());
    restarted.setActive(true);
    await restarted.check();
    await jest.advanceTimersByTimeAsync(UPDATE_RETRY_MS);
    expect(query).toHaveBeenCalledTimes(2);
    restarted.setActive(false);
  });

  test('storage failure clears checking and can recover', async () => {
    const {controller, store, query} = fixture();
    store.read.mockRejectedValueOnce(new Error('Read failed'));
    await controller.check();
    expect(controller.checking).toBe(false);
    expect(controller.error).toBe('Read failed');
    await controller.check(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(controller.error).toBeNull();
  });

  test.each(['broken json', 'null', '{"nextCheckAt":"bad"}'])(
    'invalid saved state does not disable checks: %s',
    async raw => {
      const {controller, store, query} = fixture();
      store.read.mockResolvedValue(raw);
      await controller.check();
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  test('an installed app or engine update invalidates old cached results', async () => {
    const {controller, store, query} = fixture();
    store.read.mockResolvedValue(
      JSON.stringify({
        repo: 'owner/releases',
        version: '0.0.1',
        engine: PINNED_LLAMA_CPP_COMMIT,
        lastCheckedAt: Date.now(),
        nextCheckAt: Date.now() + UPDATE_INTERVAL_MS,
        data: result,
      }),
    );
    await controller.check();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
