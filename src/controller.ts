import * as RNFS from '@dr.pogodin/react-native-fs';
import {initLlama, LlamaContext} from 'llama.rn';
import {NativeModules} from 'react-native';
import {
  defaults,
  fitMessages,
  Message,
  readSaved,
  SaveQueue,
  Session,
  Settings,
  validateSettings,
} from './chat';

export const statePath = `${RNFS.LibraryDirectoryPath}/pocketpal16.json`;
export const modelDirectory = `${RNFS.DocumentDirectoryPath}/models`;
export type LocalModel = {name: string; path: string; size: number};

export class ChatController {
  sessions: Session[] = [];
  settings = {...defaults};
  models: LocalModel[] = [];
  activeId: string | null = null;
  loadedPath: string | null = null;
  backend = '';
  ready = false;
  busy = false;
  generating = false;
  error = '';
  private context: LlamaContext | null = null;
  private listeners = new Set<() => void>();
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private inBackground = false;
  private saves = new SaveQueue(raw =>
    NativeModules.RuntimeModule.writeState(raw, statePath),
  );

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notify = () => {
    this.listeners.forEach(listener => listener());
  };
  report = (error: unknown) => {
    this.error = error instanceof Error ? error.message : String(error);
    this.notify();
  };
  get active() {
    return this.sessions.find(session => session.id === this.activeId);
  }
  async initialize() {
    try {
      const state = readSaved(
        (await RNFS.exists(statePath))
          ? await RNFS.readFile(statePath, 'utf8')
          : null,
      );
      this.sessions = state.sessions.map(session => ({
        ...session,
        // App updates can change the iOS data-container UUID.
        model: session.model.includes('/Documents/models/')
          ? `${modelDirectory}/${session.model.split('/').pop()}`
          : session.model,
      }));
      this.settings = state.settings;
      this.activeId = this.sessions[0]?.id ?? null;
      await this.refreshModels();
      for (const file of await RNFS.readDir(modelDirectory)) {
        if (file.isFile() && /^\.import-\d+\.partial$/.test(file.name)) {
          await RNFS.unlink(file.path);
        }
      }
      this.ready = true;
      this.notify();
    } catch (error) {
      this.report(error);
    }
  }
  async persist() {
    await this.saves.save({sessions: this.sessions, settings: this.settings});
  }
  async refreshModels() {
    await RNFS.mkdir(modelDirectory);
    this.models = (await RNFS.readDir(modelDirectory))
      .filter(file => file.isFile() && /\.gguf$/i.test(file.name))
      .map(file => ({
        name: file.name,
        path: file.path,
        size: Number(file.size),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.notify();
  }
  async importModel(uri: string, name: string) {
    if (this.busy) {
      return;
    }
    if (!/\.gguf$/i.test(name)) {
      throw new Error('Choose a GGUF model file.');
    }
    this.busy = true;
    this.error = '';
    this.notify();
    const safeName = name.replace(/[/\\]/g, '_');
    let destination = `${modelDirectory}/${safeName}`;
    const temporary = `${modelDirectory}/.import-${Date.now()}.partial`;
    try {
      let suffix = 1;
      while (await RNFS.exists(destination)) {
        destination = `${modelDirectory}/${safeName.slice(0, -5)} (${suffix++}).gguf`;
      }
      await RNFS.copyFile(
        decodeURIComponent(uri.replace(/^file:\/\//, '')),
        temporary,
      );
      const header = await RNFS.read(temporary, 4, 0, 'ascii');
      if (header !== 'GGUF') {
        throw new Error('This file does not have a GGUF header.');
      }
      await RNFS.moveFile(temporary, destination);
      await this.refreshModels();
    } finally {
      try {
        if (await RNFS.exists(temporary)) {
          await RNFS.unlink(temporary);
        }
      } finally {
        this.busy = false;
        this.notify();
      }
    }
  }
  async loadModel(path: string) {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.error = '';
    this.notify();
    try {
      await this.releaseContext();
      this.context = await initLlama({
        model: path,
        n_ctx: this.settings.context,
        n_batch: 128,
        n_ubatch: 128,
        n_parallel: 1,
        n_gpu_layers: this.settings.gpu ? 99 : 0,
        ...(this.settings.gpu ? {} : {devices: ['CPU']}),
        flash_attn_type: 'off',
        use_mmap: true,
        use_mlock: false,
      });
      if (this.inBackground) {
        await this.releaseContext();
        return;
      }
      this.loadedPath = path;
      this.backend = this.context.gpu ? 'Metal' : 'CPU';
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  private async releaseContext() {
    const context = this.context;
    if (context) {
      await context.release();
    }
    this.context = null;
    this.loadedPath = null;
    this.backend = '';
  }
  async unload() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.notify();
    try {
      await this.releaseContext();
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  newChat() {
    if (this.busy || !this.ready) {
      return;
    }
    const session: Session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: 'New chat',
      model: '',
      messages: [],
    };
    this.sessions.unshift(session);
    this.activeId = session.id;
    this.notify();
    this.persist().catch(this.report);
  }
  selectChat(id: string) {
    if (!this.busy) {
      this.activeId = id;
      this.notify();
    }
  }
  async deleteChat(id: string) {
    if (this.busy) {
      return;
    }
    this.sessions = this.sessions.filter(session => session.id !== id);
    if (this.activeId === id) {
      this.activeId = this.sessions[0]?.id ?? null;
    }
    this.notify();
    await this.persist();
  }
  async updateSettings(settings: Settings) {
    if (this.busy) {
      return;
    }
    const next = validateSettings(settings);
    this.busy = true;
    this.notify();
    try {
      if (
        next.context !== this.settings.context ||
        next.gpu !== this.settings.gpu
      ) {
        await this.releaseContext();
      }
      this.settings = next;
      await this.persist();
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async retry() {
    const messages = this.active?.messages;
    if (!messages?.length) {
      return;
    }
    const lastUser =
      messages[messages.length - 1].role === 'user'
        ? messages.length - 1
        : messages.length - 2;
    if (lastUser >= 0) {
      await this.send(messages[lastUser].content, true);
    }
  }
  async send(text: string, retry = false) {
    if (!text.trim() || this.busy || this.inBackground) {
      return false;
    }
    if (!this.context || !this.loadedPath) {
      throw new Error('Load a model first.');
    }
    if (!this.active) {
      this.newChat();
    }
    const session = this.active!;
    const context = this.context;
    if (
      session.model &&
      session.model !== this.loadedPath &&
      session.messages.length
    ) {
      throw new Error(
        'This conversation uses a different model. Load its model or start a new chat.',
      );
    }
    session.model = this.loadedPath;
    if (!session.messages.length) {
      session.title = text.trim().slice(0, 50);
    }
    const previous = session.messages.slice();
    if (retry) {
      const lastUser =
        session.messages[session.messages.length - 1].role === 'user'
          ? session.messages.length - 1
          : session.messages.length - 2;
      session.messages = session.messages.slice(0, lastUser);
    } else if (previous[previous.length - 1]?.role === 'user') {
      throw new Error(
        'The last response was interrupted. Tap Retry to finish it, or start a new chat.',
      );
    }
    session.messages.push({role: 'user', content: text.trim()});
    const response: Message = {role: 'assistant', content: ''};
    this.busy = true;
    this.generating = true;
    this.stopRequested = false;
    this.error = '';
    this.notify();
    let started = false;
    let accepted = false;
    try {
      let formattedPrompt = '';
      let stops: string[] = [];
      await fitMessages(session.messages, this.settings, async prompt => {
        const formatted = await context.getFormattedChat(prompt, undefined, {
          enable_thinking: false,
          force_pure_content: true,
        });
        formattedPrompt = formatted.prompt;
        stops =
          'additional_stops' in formatted
            ? (formatted.additional_stops ?? [])
            : [];
        return (await context.tokenize(formattedPrompt)).tokens.length;
      });
      if (this.stopRequested) {
        session.messages = previous;
        return false;
      }
      await this.persist();
      if (this.stopRequested) {
        session.messages = previous;
        return false;
      }
      session.messages.push(response);
      started = true;
      NativeModules.RuntimeModule?.activate();
      const result = await context.completion(
        {
          prompt: formattedPrompt,
          stop: stops,
          n_predict: this.settings.maxTokens,
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
          enable_thinking: false,
        },
        data => {
          response.content =
            data.accumulated_text ?? response.content + data.token;
          if (!this.streamTimer) {
            this.streamTimer = setTimeout(() => {
              this.streamTimer = null;
              this.notify();
            }, 80);
          }
        },
      );
      response.content = result.text || response.content;
      accepted = !!response.content;
    } catch (error) {
      if (!started) {
        session.messages = previous;
      }
      this.report(error);
    } finally {
      if (this.streamTimer) {
        clearTimeout(this.streamTimer);
        this.streamTimer = null;
      }
      if (started && !response.content) {
        session.messages = previous;
      }
      NativeModules.RuntimeModule?.deactivate();
      try {
        await this.persist();
      } finally {
        this.busy = false;
        this.generating = false;
        this.notify();
      }
    }
    return accepted;
  }
  async stop() {
    this.stopRequested = true;
    if (this.context && this.generating) {
      await this.context.stopCompletion();
    }
  }
  foreground() {
    this.inBackground = false;
  }
  async background() {
    this.inBackground = true;
    try {
      await this.stop();
    } finally {
      NativeModules.RuntimeModule?.deactivate();
      if (this.ready) {
        await this.persist();
      }
    }
  }
}
export const controller = new ChatController();
