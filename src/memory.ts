export const MIB = 1024 * 1024;
export const HARD_HEADROOM_BYTES = 96 * MIB;
export const TIGHT_HEADROOM_BYTES = 256 * MIB;
export const CRITICAL_GEN_BYTES = 128 * MIB;
export const MAX_PHYSICAL_RATIO = 0.8;
export const RUNTIME_OVERHEAD = 1.1;
export const COMPUTE_BUFFER_BYTES = 32 * MIB;
export const MIN_KV_PER_1K_BYTES = 32 * MIB;
export const KV_SIZE_RATIO_PER_1K = 0.05;

export type NativeMemoryInfo = {
  availableBytes: number;
  availableKnown: boolean;
  footprintBytes: number;
  totalBytes: number;
};

export type NativeCpuInfo = {
  activeCores: number;
  performanceCores: number;
};

export type MemoryFitStatus = 'fits' | 'tight' | 'blocked' | 'unknown';

export type MemoryBudget = {
  estimatedBytes: number;
  availableBytes: number;
  remainingBytes: number;
  status: MemoryFitStatus;
};

export function formatMiB(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${Math.round(safe / MIB)} MiB`;
}

export function estimateModelMemory(
  fileBytes: number,
  contextTokens: number,
): number {
  const weights = Number.isFinite(fileBytes) && fileBytes > 0 ? fileBytes : 0;
  const ctx =
    Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 1024;
  const kvPer1k = Math.max(MIN_KV_PER_1K_BYTES, weights * KV_SIZE_RATIO_PER_1K);
  const kvBytes = kvPer1k * (ctx / 1024);
  return Math.round(
    weights * RUNTIME_OVERHEAD + kvBytes + COMPUTE_BUFFER_BYTES,
  );
}

export function evaluateMemoryBudget(
  fileBytes: number,
  contextTokens: number,
  memoryInfo: NativeMemoryInfo | null,
): MemoryBudget {
  const estimatedBytes = estimateModelMemory(fileBytes, contextTokens);
  if (!memoryInfo || !memoryInfo.availableKnown) {
    return {
      estimatedBytes,
      availableBytes: 0,
      remainingBytes: 0,
      status: 'unknown',
    };
  }

  const availableBytes = Math.max(0, memoryInfo.availableBytes);
  const remainingBytes = availableBytes - estimatedBytes;
  const exceedsAvailable =
    estimatedBytes > availableBytes - HARD_HEADROOM_BYTES;
  const exceedsPhysical =
    memoryInfo.totalBytes > 0 &&
    estimatedBytes > memoryInfo.totalBytes * MAX_PHYSICAL_RATIO;

  let status: MemoryFitStatus = 'fits';
  if (exceedsAvailable || exceedsPhysical) {
    status = 'blocked';
  } else if (remainingBytes < TIGHT_HEADROOM_BYTES) {
    status = 'tight';
  }

  return {
    estimatedBytes,
    availableBytes,
    remainingBytes,
    status,
  };
}

export function canPotentiallyFitAfterUnload(
  fileBytes: number,
  contextTokens: number,
  memoryInfo: NativeMemoryInfo | null,
  loadedModelBytes: number,
): boolean {
  if (!memoryInfo || !memoryInfo.availableKnown) {
    return true;
  }
  const estimatedBytes = estimateModelMemory(fileBytes, contextTokens);
  if (
    memoryInfo.totalBytes > 0 &&
    estimatedBytes > memoryInfo.totalBytes * MAX_PHYSICAL_RATIO
  ) {
    return false;
  }
  const projectedAvailable =
    Math.max(0, memoryInfo.availableBytes) + Math.max(0, loadedModelBytes);
  return estimatedBytes <= projectedAvailable - HARD_HEADROOM_BYTES;
}

export function resolveThreadCount(
  requestedThreads: number,
  cpuInfo: NativeCpuInfo | null,
): number {
  const activeCores =
    cpuInfo && Number.isFinite(cpuInfo.activeCores) && cpuInfo.activeCores > 0
      ? Math.floor(cpuInfo.activeCores)
      : 0;
  const maxCores = activeCores > 0 ? activeCores : 6;

  if (Number.isInteger(requestedThreads) && requestedThreads > 0) {
    return Math.min(Math.max(1, requestedThreads), maxCores);
  }

  const perfCores =
    cpuInfo &&
    Number.isFinite(cpuInfo.performanceCores) &&
    cpuInfo.performanceCores > 0
      ? Math.floor(cpuInfo.performanceCores)
      : 0;

  if (perfCores >= 2) {
    return Math.min(perfCores, maxCores);
  }
  if (activeCores > 0) {
    return activeCores <= 4
      ? activeCores
      : Math.max(1, Math.floor(activeCores * 0.8));
  }
  return 2;
}

const warnStop = (err: unknown) => console.warn('[stop] failed:', err);

export function stopQuietly(stop: () => unknown): void {
  try {
    Promise.resolve(stop()).catch(warnStop);
  } catch (err) {
    warnStop(err);
  }
}

export async function stopQuietlyAsync(stop: () => unknown): Promise<void> {
  try {
    await stop();
  } catch (err) {
    warnStop(err);
  }
}
