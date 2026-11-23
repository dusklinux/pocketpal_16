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
import {
  canPotentiallyFitAfterUnload,
  CRITICAL_GEN_BYTES,
  estimateModelMemory,
  evaluateMemoryBudget,
  formatMiB,
  MemoryFitStatus,
  NativeCpuInfo,
  NativeMemoryInfo,
  resolveThreadCount,
  stopQuietlyAsync,
} from './memory';
import {
  isModelFilePath,
  isSafePathSegment,
  rebaseModelPath,
  safeDecodeUriPath,
  sanitizeModelFilename,
} from './pathGuard';

export const statePath = `${RNFS.LibraryDirectoryPath}/pocketpal16.json`;
export const modelDirectory = `${RNFS.DocumentDirectoryPath}/models`;
export type LocalModel = {
  name: string;
  path: string;
  size: number;
  estimatedBytes?: number;
  fitStatus?: MemoryFitStatus;
};

export class ChatController {
  sessions: Session[] = [];
  settings: Settings = {...defaults};
  models: LocalModel[] = [];
  activeId: string | null = null;
  loadedPath: string | null = null;
  lastModelPath: string | null = null;
  loadingModel = false;
  backend = '';
  activeThreads: number | null = null;
  memoryInfo: NativeMemoryInfo | null = null;
  cpuInfo: NativeCpuInfo | null = null;
  memoryWarningNote = '';
  ready = false;
  busy = false;
  generating = false;
  error = '';
  private context: LlamaContext | null = null;
  private listeners = new Set<() => void>();
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private completing = false;
  private stopping = false;
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
  clearMemoryWarningNote = () => {
    this.memoryWarningNote = '';
    this.notify();
  };
  get active() {
    return this.sessions.find(session => session.id === this.activeId);
  }

  private async queryMemoryInfo(): Promise<NativeMemoryInfo | null> {
    try {
      const info = await NativeModules.RuntimeModule?.getMemoryInfo?.();
      if (
        info &&
        typeof info.availableBytes === 'number' &&
        typeof info.availableKnown === 'boolean' &&
        typeof info.footprintBytes === 'number' &&
        typeof info.totalBytes === 'number'
      ) {
        this.memoryInfo = info;
        return info;
      }
    } catch {
      // Degrade cleanly when native telemetry is unavailable.
    }
    return this.memoryInfo;
  }

  private async queryCpuInfo(): Promise<NativeCpuInfo | null> {
    try {
      const info = await NativeModules.RuntimeModule?.getCpuInfo?.();
      if (
        info &&
        typeof info.activeCores === 'number' &&
        typeof info.performanceCores === 'number'
      ) {
        this.cpuInfo = info;
        return info;
      }
    } catch {
      // Degrade cleanly when native CPU query is unavailable.
    }
    return this.cpuInfo;
  }

  private applyModelEstimates() {
    this.models = this.models.map(model => {
      const budget = evaluateMemoryBudget(
        model.size,
        this.settings.context,
        this.memoryInfo,
      );
      return {
        ...model,
        estimatedBytes: budget.estimatedBytes,
        fitStatus: budget.status,
      };
    });
  }

  async refreshTelemetry() {
    if (!this.cpuInfo) {
      await this.queryCpuInfo();
    }
    await this.queryMemoryInfo();
    this.applyModelEstimates();
    this.notify();
  }

  async initialize() {
    try {
      await Promise.all([this.queryCpuInfo(), this.queryMemoryInfo()]);
      const state = readSaved(
        (await RNFS.exists(statePath))
          ? await RNFS.readFile(statePath, 'utf8')
          : null,
      );
      this.sessions = state.sessions.map(session => ({
        ...session,
        // App updates can change the iOS data-container UUID.
        model: rebaseModelPath(session.model, modelDirectory),
      }));
      const rebasedLast = state.lastModel
        ? rebaseModelPath(state.lastModel, modelDirectory)
        : '';
      this.lastModelPath = rebasedLast || null;
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
    await this.saves.save({
      sessions: this.sessions,
      settings: this.settings,
      lastModel: this.lastModelPath,
    });
  }
  async refreshModels() {
    await RNFS.mkdir(modelDirectory);
    await this.queryMemoryInfo();
    this.models = (await RNFS.readDir(modelDirectory))
      .filter(
        file =>
          file.isFile() &&
          isSafePathSegment(file.name) &&
          /\.gguf$/i.test(file.name),
      )
      .map(file => ({
        name: file.name,
        // Directory listings can use /private/var while Documents uses /var.
        // Keep one runtime-discovered spelling for saved and listed models.
        path: `${modelDirectory}/${file.name}`,
        size: Number(file.size),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.applyModelEstimates();
    this.notify();
  }
  async importModel(uri: string, name: string) {
    if (this.busy) {
      return;
    }
    const safeName = sanitizeModelFilename(name);
    this.busy = true;
    this.error = '';
    this.notify();
    let destination = `${modelDirectory}/${safeName}`;
    const temporary = `${modelDirectory}/.import-${Date.now()}.partial`;
    try {
      let suffix = 1;
      while (await RNFS.exists(destination)) {
        destination = `${modelDirectory}/${safeName.slice(0, -5)} (${suffix++}).gguf`;
      }
      if (!isModelFilePath(destination, modelDirectory)) {
        throw new Error('Model destination path is outside the models folder.');
      }
      await RNFS.copyFile(safeDecodeUriPath(uri), temporary);
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
  async ensureModel() {
    if (!this.ready || this.context || this.busy || this.inBackground) return;
    const path =
      this.lastModelPath ??
      (this.models.length === 1 ? this.models[0].path : null);
    if (!path) return;
    if (!this.models.some(model => model.path === path)) {
      throw new Error(
        'The last model is missing. Import it again or select another model in Models.',
      );
    }
    await this.loadModel(path);
  }
  async loadModel(path: string) {
    if (this.busy) {
      return;
    }
    const targetPath = isModelFilePath(path, modelDirectory)
      ? path
      : rebaseModelPath(path, modelDirectory);
    if (!targetPath || !isModelFilePath(targetPath, modelDirectory)) {
      throw new Error('Model path is outside the allowed models folder.');
    }
    this.busy = true;
    this.loadingModel = true;
    this.error = '';
    this.memoryWarningNote = '';
    this.notify();
    try {
      const listed = this.models.find(model => model.path === targetPath);
      let fileSize = listed?.size ?? 0;
      if (!fileSize && typeof RNFS.stat === 'function') {
        try {
          const stat = await RNFS.stat(targetPath);
          fileSize = Number(stat.size) || 0;
        } catch {
          fileSize = 0;
        }
      }

      const preMemory = await this.queryMemoryInfo();
      if (this.context && this.loadedPath && fileSize > 0) {
        const currentLoadedSize =
          this.models.find(model => model.path === this.loadedPath)?.size ?? 0;
        if (
          !canPotentiallyFitAfterUnload(
            fileSize,
            this.settings.context,
            preMemory,
            currentLoadedSize,
          )
        ) {
          const est = estimateModelMemory(fileSize, this.settings.context);
          throw new Error(
            `Model needs about ${formatMiB(est)} at ${this.settings.context} context, which exceeds available iOS memory. Lower context in Settings or choose a smaller quantization.`,
          );
        }
      }

      await this.releaseContext();

      const postMemory = await this.queryMemoryInfo();
      if (fileSize > 0) {
        const budget = evaluateMemoryBudget(
          fileSize,
          this.settings.context,
          postMemory,
        );
        if (budget.status === 'blocked') {
          throw new Error(
            `Not enough memory to load this model safely (needs ~${formatMiB(budget.estimatedBytes)}, available ${formatMiB(budget.availableBytes)}). Lower context tokens in Settings or choose a smaller model.`,
          );
        }
        if (budget.status === 'tight') {
          this.memoryWarningNote = `Tight memory headroom (~${formatMiB(Math.max(0, budget.remainingBytes))} free after load). Lower context if iOS becomes unstable.`;
        }
      }

      if (!this.cpuInfo) {
        await this.queryCpuInfo();
      }
      const threads = resolveThreadCount(this.settings.threads, this.cpuInfo);
      this.context = await initLlama({
        model: targetPath,
        n_ctx: this.settings.context,
        n_batch: 128,
        n_ubatch: 128,
        n_parallel: 1,
        n_threads: threads,
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
      this.loadedPath = targetPath;
      this.backend = this.context.gpu ? 'Metal' : 'CPU';
      this.activeThreads = threads;
      this.lastModelPath = targetPath;
      await this.persist();
      await this.queryMemoryInfo();
      this.applyModelEstimates();
    } finally {
      this.loadingModel = false;
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
    this.activeThreads = null;
  }
  async unload() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.notify();
    try {
      await this.releaseContext();
      await this.queryMemoryInfo();
      this.applyModelEstimates();
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
      const contextChanged = next.context !== this.settings.context;
      if (
        contextChanged ||
        next.gpu !== this.settings.gpu ||
        next.threads !== this.settings.threads
      ) {
        await this.releaseContext();
        await this.queryMemoryInfo();
      }
      this.settings = next;
      if (contextChanged) {
        this.applyModelEstimates();
      }
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
      await this.ensureModel();
      if (this.inBackground) return false;
      if (!this.context || !this.loadedPath) {
        throw new Error('Import or select a model in Models first.');
      }
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
      this.completing = true;
      const result = await context.completion(
        {
          prompt: formattedPrompt,
          stop: stops,
          n_predict: this.settings.maxTokens,
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
          top_k: this.settings.topK,
          min_p: this.settings.minP,
          penalty_repeat: this.settings.repeatPenalty,
          penalty_present: this.settings.presencePenalty,
          ...(this.settings.seed >= 0 ? {seed: this.settings.seed} : {}),
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
      this.completing = false;
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
    if (this.stopping || !this.completing || !this.context) {
      return;
    }
    const context = this.context;
    this.stopping = true;
    try {
      await stopQuietlyAsync(() => context.stopCompletion());
    } finally {
      this.stopping = false;
    }
  }
  async handleMemoryWarning() {
    const mem = await this.queryMemoryInfo();
    this.applyModelEstimates();
    if (!this.busy && this.context) {
      await this.unload();
      if (!this.context) {
        this.memoryWarningNote =
          'Model unloaded after an iOS low-memory warning.';
        this.notify();
      }
      return;
    }
    if (
      this.generating &&
      (!mem || !mem.availableKnown || mem.availableBytes < CRITICAL_GEN_BYTES)
    ) {
      await this.stop();
      this.memoryWarningNote =
        'Generation stopped early due to low iOS memory.';
      this.notify();
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
