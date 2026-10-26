import * as RNFS from '@dr.pogodin/react-native-fs';
import {NativeModules} from 'react-native';
import {
  checkAllUpdates,
  CombinedUpdateStatus,
  DEFAULT_REPO,
  APP_VERSION,
  PINNED_LLAMA_CPP_COMMIT,
} from './updater';

export const UPDATE_INTERVAL_MS = 48 * 60 * 60 * 1000;
export const UPDATE_RETRY_MS = 60 * 60 * 1000;
export const updateStatePath = `${RNFS.LibraryDirectoryPath}/pocketpal16-updates.json`;

type Saved = {
  repo: string;
  nextCheckAt: number;
  lastCheckedAt: number;
  version: string;
  engine: string;
  data: CombinedUpdateStatus;
};
type Storage = {
  read: () => Promise<string | null>;
  write: (raw: string) => Promise<void>;
};
const storage: Storage = {
  read: async () =>
    (await RNFS.exists(updateStatePath))
      ? RNFS.readFile(updateStatePath, 'utf8')
      : null,
  write: raw => NativeModules.RuntimeModule.writeState(raw, updateStatePath),
};

export class UpdateController {
  repo = DEFAULT_REPO;
  checking = false;
  data: CombinedUpdateStatus | null = null;
  error: string | null = null;
  lastCheckedAt = 0;
  nextCheckAt = 0;
  private ready: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private store: Storage = storage,
    private query = checkAllUpdates,
    private now = Date.now,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.listeners.forEach(listener => listener());
  }

  private initialize() {
    this.ready ??= (async () => {
      const raw = await this.store.read();
      if (!raw) return;
      let saved: Saved;
      try {
        saved = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !saved ||
        typeof saved.repo !== 'string' ||
        !Number.isFinite(saved.nextCheckAt) ||
        !Number.isFinite(saved.lastCheckedAt)
      )
        return;
      this.repo = saved.repo;
      if (
        saved.version !== APP_VERSION ||
        saved.engine !== PINNED_LLAMA_CPP_COMMIT
      )
        return;
      this.data = saved.data ?? null;
      this.lastCheckedAt = saved.lastCheckedAt;
      // A clock correction must not suppress checks for more than 48 hours.
      this.nextCheckAt = Math.min(
        saved.nextCheckAt,
        this.now() + UPDATE_INTERVAL_MS,
      );
      this.notify();
    })();
    return this.ready;
  }

  setActive(active: boolean) {
    this.active = active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (active) void this.check();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) {
      this.timer = setTimeout(
        () => {
          void this.check();
        },
        Math.max(1000, this.nextCheckAt - this.now()),
      );
    }
  }

  check(force = false, repo?: string): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        await this.initialize();
        if (!force && this.now() < this.nextCheckAt) return;
        this.checking = true;
        this.error = null;
        this.repo = repo?.trim() || this.repo;
        this.notify();
        this.data = await this.query(APP_VERSION, this.repo);
        this.lastCheckedAt = this.now();
        this.nextCheckAt =
          this.lastCheckedAt +
          (this.data.appError || this.data.engineError
            ? UPDATE_RETRY_MS
            : UPDATE_INTERVAL_MS);
        await this.store.write(
          JSON.stringify({
            repo: this.repo,
            lastCheckedAt: this.lastCheckedAt,
            nextCheckAt: this.nextCheckAt,
            version: APP_VERSION,
            engine: PINNED_LLAMA_CPP_COMMIT,
            data: this.data,
          }),
        );
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.nextCheckAt = this.now() + UPDATE_RETRY_MS;
        // Allow initialization to retry after a transient storage failure.
        this.ready = null;
      } finally {
        this.checking = false;
        this.pending = null;
        this.notify();
        this.schedule();
      }
    })();
    return this.pending;
  }
}

export const updates = new UpdateController();
