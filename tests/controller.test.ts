import * as RNFS from '@dr.pogodin/react-native-fs';
import {initLlama} from 'llama.rn';
import {NativeModules} from 'react-native';
import {ChatController} from '../src/controller';
import {defaults} from '../src/chat';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/data/Documents',
  LibraryDirectoryPath: '/data/Library',
  readFile: jest.fn(),
  mkdir: jest.fn(),
  readDir: jest.fn(),
  exists: jest.fn(),
  copyFile: jest.fn(),
  moveFile: jest.fn(),
  read: jest.fn(),
  unlink: jest.fn(),
}));
jest.mock('llama.rn', () => ({initLlama: jest.fn()}));
jest.mock('react-native', () => ({
  NativeModules: {
    RuntimeModule: {
      activate: jest.fn(),
      deactivate: jest.fn(),
      writeState: jest.fn(),
    },
  },
}));
const mockInit = jest.mocked(initLlama);
const storage = NativeModules.RuntimeModule as {writeState: jest.Mock};
const files = jest.mocked(RNFS);
const context = {
  gpu: true,
  release: jest.fn(),
  stopCompletion: jest.fn(),
  getFormattedChat: jest.fn(),
  tokenize: jest.fn(),
  completion: jest.fn(),
};
async function loaded() {
  const chat = new ChatController();
  await chat.initialize();
  await chat.loadModel('/data/Documents/models/one.gguf');
  return chat;
}
beforeEach(() => {
  jest.resetAllMocks();
  storage.writeState.mockResolvedValue(undefined);
  files.mkdir.mockResolvedValue(undefined);
  files.readDir.mockResolvedValue([]);
  files.exists.mockResolvedValue(false);
  files.read.mockResolvedValue('GGUF');
  files.copyFile.mockResolvedValue(undefined);
  files.moveFile.mockResolvedValue(undefined);
  files.unlink.mockResolvedValue(undefined);
  context.release.mockResolvedValue(undefined);
  context.stopCompletion.mockResolvedValue(undefined);
  context.getFormattedChat.mockResolvedValue({
    type: 'jinja',
    prompt: 'formatted',
    additional_stops: ['<end>'],
  });
  context.tokenize.mockResolvedValue({tokens: [1, 2, 3]});
  context.completion.mockResolvedValue({text: 'hello'});
  mockInit.mockResolvedValue(
    context as unknown as Awaited<ReturnType<typeof initLlama>>,
  );
});
test('generation uses GGUF template once and saves a complete conversation', async () => {
  const chat = await loaded();
  await chat.send('hi');
  expect(chat.active?.messages).toEqual([
    {role: 'user', content: 'hi'},
    {role: 'assistant', content: 'hello'},
  ]);
  expect(context.getFormattedChat).toHaveBeenCalledTimes(1);
  expect(context.completion.mock.calls[0][0]).toMatchObject({
    prompt: 'formatted',
    stop: ['<end>'],
    n_predict: 256,
  });
  expect(
    JSON.parse(storage.writeState.mock.calls.at(-1)![0]).sessions[0].messages,
  ).toEqual(chat.active?.messages);
  expect(chat.busy).toBe(false);
  expect(NativeModules.RuntimeModule.deactivate).toHaveBeenCalled();
});
test('does not release or replace the model while generating; cancellation saves partial output', async () => {
  const chat = await loaded();
  let finish!: (value: {text: string}) => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => {
    started = resolve;
  });
  context.completion.mockImplementation((_, callback) => {
    callback({token: 'part', accumulated_text: 'part'});
    started();
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  const generation = chat.send('hi');
  await signal;
  await chat.loadModel('/other.gguf');
  await chat.unload();
  expect(context.release).not.toHaveBeenCalled();
  await chat.background();
  expect(context.stopCompletion).toHaveBeenCalled();
  expect(
    JSON.parse(storage.writeState.mock.calls.at(-1)![0]).sessions[0].messages[1]
      .content,
  ).toBe('part');
  finish({text: 'part'});
  await generation;
  expect(chat.busy).toBe(false);
});
test('cancellation during prompt preparation never starts inference', async () => {
  const chat = await loaded();
  let finish!: (value: {tokens: number[]}) => void;
  let started!: () => void;
  const signal = new Promise<void>(resolve => {
    started = resolve;
  });
  context.tokenize.mockImplementation(() => {
    started();
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  const generation = chat.send('hi');
  await signal;
  await chat.stop();
  finish({tokens: [1]});
  await generation;
  expect(context.completion).not.toHaveBeenCalled();
  expect(chat.active?.messages).toEqual([]);
});
test('startup with broken saved data cannot erase it on backgrounding', async () => {
  files.exists.mockResolvedValueOnce(true);
  files.readFile.mockResolvedValue('broken');
  const chat = new ChatController();
  await chat.initialize();
  await chat.background();
  expect(chat.ready).toBe(false);
  expect(chat.error).toBeTruthy();
  expect(storage.writeState).not.toHaveBeenCalled();
});
test('replacing a model releases the previous context before initializing another', async () => {
  const chat = await loaded();
  await chat.loadModel('/two.gguf');
  expect(context.release.mock.invocationCallOrder[0]).toBeLessThan(
    mockInit.mock.invocationCallOrder[1],
  );
});
test('settings reload only for context or backend changes', async () => {
  const chat = await loaded();
  await chat.updateSettings({...defaults, temperature: 1});
  expect(context.release).not.toHaveBeenCalled();
  await chat.updateSettings({...defaults, gpu: false});
  expect(chat.loadedPath).toBeNull();
  await chat.loadModel('/one.gguf');
  expect(mockInit.mock.calls.at(-1)![0]).toMatchObject({
    devices: ['CPU'],
    n_gpu_layers: 0,
    n_parallel: 1,
  });
});
test('cross-model history is not silently reused', async () => {
  const chat = await loaded();
  await chat.send('hi');
  await chat.loadModel('/two.gguf');
  await expect(chat.send('again')).rejects.toThrow('different model');
  expect(chat.active?.messages).toHaveLength(2);
});
test('failed completion without output restores the previous conversation', async () => {
  const chat = await loaded();
  context.completion.mockRejectedValue(new Error('failed'));
  await chat.send('hi');
  expect(chat.active?.messages).toEqual([]);
  expect(chat.error).toBe('failed');
  expect(chat.busy).toBe(false);
});
test('failed imports clean their partial file and unlock even when cleanup fails', async () => {
  const chat = await loaded();
  files.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  files.read.mockResolvedValue('oops');
  files.unlink.mockRejectedValue(new Error('cleanup failed'));
  await expect(
    chat.importModel('file:///Inbox/test.gguf', 'test.gguf'),
  ).rejects.toThrow();
  expect(files.moveFile).not.toHaveBeenCalled();
  expect(files.unlink).toHaveBeenCalled();
  expect(chat.busy).toBe(false);
});
test('duplicate model imports keep both filenames and decode the source URL', async () => {
  const chat = await loaded();
  files.exists
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false);
  await chat.importModel('file:///Inbox/a%20b.gguf', 'a b.gguf');
  expect(files.copyFile.mock.calls[0][0]).toBe('/Inbox/a b.gguf');
  expect(files.moveFile.mock.calls[0][1]).toBe(
    '/data/Documents/models/a b (1).gguf',
  );
});

test('retries a response interrupted by process termination without duplicate user turns', async () => {
  files.exists.mockResolvedValueOnce(true);
  files.readFile.mockResolvedValue(
    JSON.stringify({
      settings: defaults,
      sessions: [
        {
          id: 'saved',
          title: 'hi',
          model: '/data/Documents/models/one.gguf',
          messages: [{role: 'user', content: 'hi'}],
        },
      ],
    }),
  );
  const chat = await loaded();
  await expect(chat.send('new')).rejects.toThrow('interrupted');
  await chat.retry();
  expect(chat.active?.messages).toEqual([
    {role: 'user', content: 'hi'},
    {role: 'assistant', content: 'hello'},
  ]);
});
test('retry failure restores the original response', async () => {
  const chat = await loaded();
  await chat.send('hi');
  context.completion.mockRejectedValue(new Error('failed'));
  await chat.retry();
  expect(chat.active?.messages).toEqual([
    {role: 'user', content: 'hi'},
    {role: 'assistant', content: 'hello'},
  ]);
});

test('final write failure unlocks the controller and preserves the generated response in memory', async () => {
  const chat = await loaded();
  chat.newChat();
  await Promise.resolve();
  storage.writeState
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(chat.send('hi')).rejects.toThrow('disk full');
  expect(chat.busy).toBe(false);
  expect(chat.generating).toBe(false);
  expect(chat.active?.messages[1].content).toBe('hello');
});
test('background checkpoint survives a native stop error', async () => {
  const chat = await loaded();
  context.stopCompletion.mockRejectedValue(new Error('stop failed'));
  let finish!: (value: {text: string}) => void;
  let signal!: () => void;
  const started = new Promise<void>(resolve => {
    signal = resolve;
  });
  context.completion.mockImplementation((_, callback) => {
    callback({token: 'part'});
    signal();
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  const generation = chat.send('hi');
  await started;
  await expect(chat.background()).rejects.toThrow('stop failed');
  expect(
    JSON.parse(storage.writeState.mock.calls.at(-1)![0]).sessions[0].messages[1]
      .content,
  ).toBe('part');
  finish({text: 'part'});
  await generation;
});
test('model loading that completes in the background immediately releases its context', async () => {
  const chat = new ChatController();
  await chat.initialize();
  let finish!: (value: Awaited<ReturnType<typeof initLlama>>) => void;
  mockInit.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const loading = chat.loadModel('/one.gguf');
  await Promise.resolve();
  await chat.background();
  finish(context as unknown as Awaited<ReturnType<typeof initLlama>>);
  await loading;
  expect(chat.loadedPath).toBeNull();
  expect(context.release).toHaveBeenCalled();
  expect(chat.busy).toBe(false);
});
test('model-load failure clears the old model and releases the busy flag', async () => {
  const chat = await loaded();
  mockInit.mockRejectedValue(new Error('unsupported architecture'));
  await expect(chat.loadModel('/bad.gguf')).rejects.toThrow(
    'unsupported architecture',
  );
  expect(chat.loadedPath).toBeNull();
  expect(chat.busy).toBe(false);
});
test('appearance changes keep the model loaded', async () => {
  const chat = await loaded();
  await chat.updateSettings({...defaults, theme: 'dark'});
  expect(context.release).not.toHaveBeenCalled();
  expect(chat.settings.theme).toBe('dark');
});
test('completed streaming uses the final result, without doubling accumulated text', async () => {
  const chat = await loaded();
  context.completion.mockImplementation(async (_, callback) => {
    callback({token: 'hi', accumulated_text: 'hi'});
    callback({token: ' there', accumulated_text: 'hi there'});
    return {text: 'hi there!'};
  });
  await chat.send('hi');
  expect(chat.active?.messages[1].content).toBe('hi there!');
});

test('saved conversations follow the model directory after an iOS container move', async () => {
  files.exists.mockResolvedValue(true);
  files.readFile.mockResolvedValue(
    JSON.stringify({
      settings: defaults,
      sessions: [
        {
          id: 'saved',
          title: 'Saved',
          model: '/old-container/Documents/models/one.gguf',
          messages: [
            {role: 'user', content: 'hi'},
            {role: 'assistant', content: 'hello'},
          ],
        },
      ],
    }),
  );
  const chat = await loaded();
  expect(chat.active?.model).toBe('/data/Documents/models/one.gguf');
  await expect(chat.send('continue')).resolves.toBe(true);
});
