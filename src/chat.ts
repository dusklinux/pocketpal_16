import {ThemeMode} from './theme';

export type Message = {role: 'user' | 'assistant'; content: string};
export type Session = {
  id: string;
  title: string;
  model: string;
  messages: Message[];
};
export type Settings = {
  theme: ThemeMode;
  context: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  gpu: boolean;
  systemPrompt: string;
};
export const defaults: Settings = {
  theme: 'system',
  context: 1024,
  maxTokens: 256,
  temperature: 0.7,
  topP: 0.9,
  gpu: false,
  systemPrompt: 'You are a helpful assistant. Give clear, concise answers.',
};
export type SavedState = {
  sessions: Session[];
  settings: Settings;
  lastModel?: string | null;
};
export type PromptMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export function validateSettings(value: Settings): Settings {
  value = {...defaults, ...value};
  if (!['system', 'light', 'dark'].includes(value.theme)) {
    throw new Error('Invalid appearance setting.');
  }
  if (
    !Number.isInteger(value.context) ||
    value.context < 512 ||
    value.context > 8192
  ) {
    throw new Error('Context must be a whole number from 512 to 8192.');
  }
  if (
    !Number.isInteger(value.maxTokens) ||
    value.maxTokens < 1 ||
    value.maxTokens > value.context - 64
  ) {
    throw new Error('Output tokens must be between 1 and context minus 64.');
  }
  if (
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2
  ) {
    throw new Error('Temperature must be from 0 to 2.');
  }
  if (!Number.isFinite(value.topP) || value.topP <= 0 || value.topP > 1) {
    throw new Error('Top P must be greater than 0 and at most 1.');
  }
  if (
    typeof value.gpu !== 'boolean' ||
    typeof value.systemPrompt !== 'string'
  ) {
    throw new Error('Invalid generation settings.');
  }
  return {...value};
}

export function readSaved(raw: string | null): SavedState {
  if (raw === null) {
    return {sessions: [], settings: {...defaults}, lastModel: null};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.sessions) || !parsed.settings) {
    throw new Error('Saved data is invalid.');
  }
  if (parsed.lastModel != null && typeof parsed.lastModel !== 'string') {
    throw new Error('Saved model selection is invalid.');
  }
  const ids = new Set<string>();
  for (const session of parsed.sessions) {
    if (
      !session ||
      typeof session.id !== 'string' ||
      ids.has(session.id) ||
      typeof session.title !== 'string' ||
      typeof session.model !== 'string' ||
      !Array.isArray(session.messages)
    ) {
      throw new Error('Saved conversation is invalid.');
    }
    ids.add(session.id);
    for (const [index, message] of session.messages.entries()) {
      if (
        !message ||
        message.role !== (index % 2 === 0 ? 'user' : 'assistant') ||
        typeof message.content !== 'string'
      ) {
        throw new Error('Saved message is invalid.');
      }
    }
  }
  return {
    sessions: parsed.sessions,
    settings: validateSettings(parsed.settings),
    lastModel:
      parsed.lastModel ??
      parsed.sessions.find((session: Session) => session.model)?.model ??
      null,
  };
}

// Retain complete turns, and never truncate the system prompt or latest input.
export async function fitMessages(
  messages: Message[],
  settings: Settings,
  count: (messages: PromptMessage[]) => Promise<number>,
): Promise<PromptMessage[]> {
  const turns = messages.map(message => ({...message}));
  const system: PromptMessage[] = settings.systemPrompt.trim()
    ? [{role: 'system', content: settings.systemPrompt}]
    : [];
  const budget = settings.context - settings.maxTokens - 32;
  while (true) {
    const prompt = [...system, ...turns];
    if ((await count(prompt)) <= budget) {
      return prompt;
    }
    const nextUser = turns.findIndex(
      (message, i) => i > 0 && message.role === 'user',
    );
    if (nextUser < 0) {
      throw new Error(
        'This message and system prompt exceed the context budget. Shorten them or increase context.',
      );
    }
    turns.splice(0, nextUser);
  }
}

// Capture each snapshot at enqueue time. A failed save does not poison later saves.
export class SaveQueue {
  private pending: Promise<void> = Promise.resolve();
  constructor(private write: (raw: string) => Promise<void>) {}
  save(state: SavedState): Promise<void> {
    const raw = JSON.stringify(state);
    const operation = this.pending.then(() => this.write(raw));
    this.pending = operation.catch(() => {});
    return operation;
  }
}
