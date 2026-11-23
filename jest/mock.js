const MIB = 1024 * 1024;

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  actual.NativeModules.RuntimeModule = {
    activate: jest.fn(),
    deactivate: jest.fn(),
    copyText: jest.fn(),
    writeState: jest.fn().mockResolvedValue(undefined),
    getMemoryInfo: jest.fn().mockResolvedValue({
      availableBytes: 1536 * MIB,
      availableKnown: true,
      footprintBytes: 220 * MIB,
      totalBytes: 3072 * MIB,
    }),
    getCpuInfo: jest.fn().mockResolvedValue({
      activeCores: 6,
      performanceCores: 2,
    }),
  };
  return actual;
});

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
  stat: jest.fn().mockResolvedValue({size: 700 * MIB}),
}));

jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
}));

jest.mock('@react-native-documents/picker', () => ({
  errorCodes: {OPERATION_CANCELED: 'OPERATION_CANCELED'},
  isErrorWithCode: jest.fn(() => false),
  pick: jest.fn().mockResolvedValue([]),
}));
