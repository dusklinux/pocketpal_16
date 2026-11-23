import {
  defaults,
  parseFiniteSetting,
  readSaved,
  validateSettings,
} from '../src/chat';
import {
  canPotentiallyFitAfterUnload,
  CRITICAL_GEN_BYTES,
  estimateModelMemory,
  evaluateMemoryBudget,
  MIB,
  resolveThreadCount,
  stopQuietly,
  stopQuietlyAsync,
} from '../src/memory';
import {
  isModelFilePath,
  isSafePathSegment,
  rebaseModelPath,
  safeDecodeUriPath,
  sanitizeModelFilename,
} from '../src/pathGuard';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/Documents',
  LibraryDirectoryPath: '/mock/Library',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue(''),
  mkdir: jest.fn().mockResolvedValue(undefined),
  readDir: jest.fn().mockResolvedValue([]),
  copyFile: jest.fn().mockResolvedValue(undefined),
  read: jest.fn().mockResolvedValue('GGUF'),
  moveFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({size: 700 * 1024 * 1024}),
}));

jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
}));

jest.mock('react-native', () => ({
  NativeModules: {
    RuntimeModule: {
      activate: jest.fn(),
      deactivate: jest.fn(),
      copyText: jest.fn(),
      writeState: jest.fn().mockResolvedValue(undefined),
      getMemoryInfo: jest.fn(),
      getCpuInfo: jest.fn(),
    },
  },
}));

import * as RNFS from '@dr.pogodin/react-native-fs';
import {initLlama} from 'llama.rn';
import {NativeModules} from 'react-native';
import {ChatController, modelDirectory} from '../src/controller';

const mockRNFS = RNFS as jest.Mocked<typeof RNFS>;
const mockInitLlama = initLlama as jest.Mock;
const mockRuntime = NativeModules.RuntimeModule as {
  activate: jest.Mock;
  deactivate: jest.Mock;
  copyText: jest.Mock;
  writeState: jest.Mock;
  getMemoryInfo?: jest.Mock;
  getCpuInfo?: jest.Mock;
};

describe('pathGuard', () => {
  const dir = '/var/mobile/Containers/Data/Application/UUID/Documents/models';

  test('accepts safe segments and rejects traversal, dotfiles, and control chars', () => {
    expect(isSafePathSegment('LFM2.5-1.2B-Instruct-Q4_K_M.gguf')).toBe(true);
    expect(isSafePathSegment('model..v2.gguf')).toBe(true);
    expect(isSafePathSegment('.')).toBe(false);
    expect(isSafePathSegment('..')).toBe(false);
    expect(isSafePathSegment('.hidden.gguf')).toBe(false);
    expect(isSafePathSegment('a/b.gguf')).toBe(false);
    expect(isSafePathSegment('a\\b.gguf')).toBe(false);
    expect(isSafePathSegment('bad\u0000name.gguf')).toBe(false);
  });

  test('validates model file paths strictly inside Documents/models', () => {
    expect(isModelFilePath(`${dir}/test.gguf`, dir)).toBe(true);
    expect(isModelFilePath(`${dir}/sub/test.gguf`, dir)).toBe(false);
    expect(isModelFilePath(`${dir}/../test.gguf`, dir)).toBe(false);
    expect(isModelFilePath('/tmp/test.gguf', dir)).toBe(false);
    expect(isModelFilePath(`${dir}/notes.txt`, dir)).toBe(false);
  });

  test('sanitizes filenames and decodes URIs with literal percent characters', () => {
    expect(sanitizeModelFilename('  ..dir/my\\model\u0007.GGUF  ')).toBe(
      'dir_my_model.GGUF',
    );
    expect(() => sanitizeModelFilename('readme.txt')).toThrow(
      'Choose a GGUF model file.',
    );
    expect(safeDecodeUriPath('file:///tmp/model%201.gguf')).toBe(
      '/tmp/model 1.gguf',
    );
    expect(safeDecodeUriPath('file:///tmp/100%working.gguf')).toBe(
      '/tmp/100%working.gguf',
    );
  });

  test('rebases container UUID paths and rejects out-of-sandbox paths', () => {
    expect(
      rebaseModelPath(
        '/var/mobile/Containers/Data/Application/OLD/Documents/models/a.gguf',
        dir,
      ),
    ).toBe(`${dir}/a.gguf`);
    expect(
      rebaseModelPath('/var/mobile/Documents/models/../../etc/passwd', dir),
    ).toBe('');
    expect(
      rebaseModelPath('/var/mobile/Documents/models/../../evil.gguf', dir),
    ).toBe('');
    expect(
      rebaseModelPath('/var/mobile/Documents/models/sub/evil.gguf', dir),
    ).toBe('');
    expect(rebaseModelPath('/tmp/outside.gguf', dir)).toBe('');
  });
});

describe('memory, thread heuristics, and stopQuietly', () => {
  test('estimates model memory and evaluates Jetsam budgets accurately', () => {
    const lfmSize = 697 * MIB;
    const est1k = estimateModelMemory(lfmSize, 1024);
    const est8k = estimateModelMemory(lfmSize, 8192);
    expect(est1k).toBeGreaterThan(800 * MIB);
    expect(est1k).toBeLessThan(900 * MIB);
    expect(est8k).toBeGreaterThan(1000 * MIB);

    const healthy = {
      availableBytes: 1500 * MIB,
      availableKnown: true,
      footprintBytes: 180 * MIB,
      totalBytes: 3072 * MIB,
    };
    expect(evaluateMemoryBudget(lfmSize, 1024, healthy).status).toBe('fits');

    const tight = {...healthy, availableBytes: 1000 * MIB};
    expect(evaluateMemoryBudget(lfmSize, 1024, tight).status).toBe('tight');

    const low = {...healthy, availableBytes: 850 * MIB};
    expect(evaluateMemoryBudget(lfmSize, 1024, low).status).toBe('blocked');

    expect(evaluateMemoryBudget(lfmSize, 1024, null).status).toBe('unknown');
    expect(
      canPotentiallyFitAfterUnload(2200 * MIB, 1024, healthy, lfmSize),
    ).toBe(false);
  });

  test('resolves optimal CPU threads for A11 2P+4E and generic CPUs', () => {
    expect(resolveThreadCount(0, {activeCores: 6, performanceCores: 2})).toBe(
      2,
    );
    expect(resolveThreadCount(0, {activeCores: 8, performanceCores: 0})).toBe(
      6,
    );
    expect(resolveThreadCount(0, {activeCores: 4, performanceCores: 0})).toBe(
      4,
    );
    expect(resolveThreadCount(10, {activeCores: 6, performanceCores: 2})).toBe(
      6,
    );
    expect(resolveThreadCount(0, null)).toBe(2);
  });

  test('stopQuietly suppresses sync throws and async rejections', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      stopQuietly(() => {
        throw new Error('sync boom');
      }),
    ).not.toThrow();
    await expect(
      stopQuietlyAsync(async () => {
        throw new Error('async boom');
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe('chat settings migration and validation', () => {
  test('migrates legacy saved settings without new sampler fields', () => {
    const legacy = JSON.stringify({
      sessions: [],
      settings: {
        theme: 'dark',
        context: 1024,
        maxTokens: 256,
        temperature: 0.7,
        topP: 0.9,
        gpu: false,
        systemPrompt: 'Hi',
      },
      lastModel: null,
    });
    const state = readSaved(legacy);
    expect(state.settings.topK).toBe(defaults.topK);
    expect(state.settings.minP).toBe(defaults.minP);
    expect(state.settings.repeatPenalty).toBe(defaults.repeatPenalty);
    expect(state.settings.presencePenalty).toBe(defaults.presencePenalty);
    expect(state.settings.seed).toBe(-1);
    expect(state.settings.threads).toBe(0);
  });

  test('validates expanded samplers and rejects blank numeric strings', () => {
    expect(() => parseFiniteSetting('   ', 'Temperature')).toThrow(
      'Temperature cannot be empty.',
    );
    expect(() => validateSettings({...defaults, topK: -1})).toThrow();
    expect(() => validateSettings({...defaults, minP: 1.5})).toThrow();
    expect(() => validateSettings({...defaults, repeatPenalty: 0.2})).toThrow();
    expect(() => validateSettings({...defaults, presencePenalty: 3})).toThrow();
    expect(() => validateSettings({...defaults, seed: -2})).toThrow();
    expect(() => validateSettings({...defaults, threads: 32})).toThrow();
  });
});

describe('ChatController backports', () => {
  const modelPath = `${modelDirectory}/LFM2.5-1.2B-Instruct-Q4_K_M.gguf`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRuntime.getMemoryInfo = jest.fn().mockResolvedValue({
      availableBytes: 1600 * MIB,
      availableKnown: true,
      footprintBytes: 180 * MIB,
      totalBytes: 3072 * MIB,
    });
    mockRuntime.getCpuInfo = jest.fn().mockResolvedValue({
      activeCores: 6,
      performanceCores: 2,
    });
    mockRNFS.exists.mockResolvedValue(false);
    mockRNFS.readDir.mockResolvedValue([
      {
        name: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
        path: modelPath,
        size: 697 * MIB,
        isFile: () => true,
      } as Awaited<ReturnType<typeof RNFS.readDir>>[number],
    ]);
  });

  test('loads model with resolved A11 thread count and forwards expanded samplers', async () => {
    const completion = jest.fn().mockResolvedValue({text: 'Hello!'});
    const release = jest.fn().mockResolvedValue(undefined);
    mockInitLlama.mockResolvedValue({
      gpu: false,
      getFormattedChat: jest.fn().mockResolvedValue({prompt: 'hi'}),
      tokenize: jest.fn().mockResolvedValue({tokens: [1, 2, 3]}),
      completion,
      stopCompletion: jest.fn().mockResolvedValue(undefined),
      release,
    });

    const ctrl = new ChatController();
    await ctrl.initialize();
    await ctrl.loadModel(modelPath);

    expect(mockInitLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: modelPath,
        n_threads: 2,
        n_gpu_layers: 0,
        devices: ['CPU'],
      }),
    );
    expect(ctrl.activeThreads).toBe(2);

    // Sampler-only update should NOT unload the loaded model.
    await ctrl.updateSettings({
      ...ctrl.settings,
      topK: 30,
      minP: 0.1,
      repeatPenalty: 1.2,
      presencePenalty: 0.25,
      seed: -1,
    });
    expect(release).not.toHaveBeenCalled();
    expect(ctrl.loadedPath).toBe(modelPath);

    await ctrl.send('Hello');
    const completionArgs = completion.mock.calls[0][0];
    expect(completionArgs).toMatchObject({
      top_k: 30,
      min_p: 0.1,
      penalty_repeat: 1.2,
      penalty_present: 0.25,
    });
    expect(completionArgs.seed).toBeUndefined();
  });

  test('blocks oversized models before initLlama and handles missing native telemetry', async () => {
    const ctrl = new ChatController();
    mockRuntime.getMemoryInfo = jest.fn().mockResolvedValue({
      availableBytes: 500 * MIB,
      availableKnown: true,
      footprintBytes: 200 * MIB,
      totalBytes: 3072 * MIB,
    });
    await ctrl.initialize();
    await expect(ctrl.loadModel(modelPath)).rejects.toThrow(
      'Not enough memory to load this model safely',
    );
    expect(mockInitLlama).not.toHaveBeenCalled();

    // Missing native methods degrade gracefully.
    delete mockRuntime.getMemoryInfo;
    delete mockRuntime.getCpuInfo;
    const ctrl2 = new ChatController();
    await ctrl2.initialize();
    expect(ctrl2.ready).toBe(true);

    await expect(ctrl2.loadModel('/outside.gguf')).rejects.toThrow(
      'Model path is outside the allowed models folder.',
    );
  });

  test('stop() and critical handleMemoryWarning() never throw on rejection and guard completing state', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const stopCompletion = jest
      .fn()
      .mockRejectedValue(new Error('already stopped'));
    let resolveCompletion: (val: {text: string}) => void = () => {};
    mockInitLlama.mockResolvedValue({
      gpu: false,
      getFormattedChat: jest.fn().mockResolvedValue({prompt: 'hi'}),
      tokenize: jest.fn().mockResolvedValue({tokens: [1, 2]}),
      completion: jest.fn(
        () =>
          new Promise(resolve => {
            resolveCompletion = resolve;
          }),
      ),
      stopCompletion,
      release: jest.fn().mockResolvedValue(undefined),
    });

    const ctrl = new ChatController();
    await ctrl.initialize();
    await ctrl.loadModel(modelPath);

    // Calling stop() before completion starts does not invoke native stopCompletion
    await expect(ctrl.stop()).resolves.toBeUndefined();
    expect(stopCompletion).not.toHaveBeenCalled();

    const sendPromise = ctrl.send('Tell me a story');
    await new Promise(resolve => setTimeout(() => resolve(undefined), 10));

    mockRuntime.getMemoryInfo = jest.fn().mockResolvedValue({
      availableBytes: CRITICAL_GEN_BYTES - 10 * MIB,
      availableKnown: true,
      footprintBytes: 1200 * MIB,
      totalBytes: 3072 * MIB,
    });

    // Calling stop() directly during completion suppresses native rejection
    await expect(ctrl.stop()).resolves.toBeUndefined();
    expect(stopCompletion).toHaveBeenCalledTimes(1);

    // handleMemoryWarning also delegates to stop() safely without throwing
    await expect(ctrl.handleMemoryWarning()).resolves.toBeUndefined();
    expect(ctrl.memoryWarningNote).toContain('stopped early');

    // background() also contains stop rejections cleanly
    await expect(ctrl.background()).resolves.toBeUndefined();

    resolveCompletion({text: 'Partial'});
    await sendPromise;
    warnSpy.mockRestore();
  });

  test('model switching queries fresh memory and succeeds when memory frees post-unload', async () => {
    const model2Path = `${modelDirectory}/model2.gguf`;
    mockRNFS.readDir.mockResolvedValue([
      {
        name: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
        path: modelPath,
        size: 700 * MIB,
        isFile: () => true,
      },
      {
        name: 'model2.gguf',
        path: model2Path,
        size: 700 * MIB,
        isFile: () => true,
      },
    ] as any);

    mockRuntime.getMemoryInfo = jest.fn().mockResolvedValue({
      availableBytes: 1600 * MIB,
      availableKnown: true,
      footprintBytes: 200 * MIB,
      totalBytes: 3072 * MIB,
    });

    const ctrl = new ChatController();
    await ctrl.initialize();
    await ctrl.loadModel(modelPath);
    expect(ctrl.loadedPath).toBe(modelPath);

    // When Model 1 is resident, memory is tight (900 MiB pre-unload).
    // After Model 1 unloads, memory bounces back to 1600 MiB post-unload.
    mockRuntime.getMemoryInfo = jest
      .fn()
      .mockResolvedValueOnce({
        availableBytes: 900 * MIB,
        availableKnown: true,
        footprintBytes: 800 * MIB,
        totalBytes: 3072 * MIB,
      })
      .mockResolvedValueOnce({
        availableBytes: 1600 * MIB,
        availableKnown: true,
        footprintBytes: 200 * MIB,
        totalBytes: 3072 * MIB,
      });

    // Switching to model 2 evaluates post-unload memory and succeeds
    await expect(ctrl.loadModel(model2Path)).resolves.toBeUndefined();
    expect(ctrl.loadedPath).toBe(model2Path);
  });
});
