import React, {useEffect, useReducer, useRef, useState} from 'react';
import {
  Alert,
  Appearance,
  NativeModules,
  StatusBar,
  useColorScheme,
  AppState,
  Button,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {
  errorCodes,
  isErrorWithCode,
  pick,
} from '@react-native-documents/picker';
import {controller as chat, modelDirectory} from './src/controller';
import {parseFiniteSetting, Settings} from './src/chat';
import {formatMiB, MemoryFitStatus, resolveThreadCount} from './src/memory';
import {Palette, palettes, resolveTheme, ThemeMode} from './src/theme';
import {
  APP_VERSION,
  DEFAULT_REPO,
  installWithTrollStore,
  PINNED_LLAMA_CPP_SHORT,
  PINNED_LLAMA_CPP_DATE,
} from './src/updater';
import {updates} from './src/update-controller';

type Page = 'Chat' | 'Models' | 'History' | 'Settings';
const attempt = (work: () => Promise<unknown>) => {
  work().catch(chat.report);
};

function fitStatusLabel(status?: MemoryFitStatus): string {
  switch (status) {
    case 'fits':
      return 'Fits';
    case 'tight':
      return 'Tight headroom';
    case 'blocked':
      return 'Exceeds available RAM';
    default:
      return '';
  }
}

function IconButton({
  label,
  symbol,
  onPress,
  disabled = false,
  styles,
}: {
  label: string;
  symbol: string;
  onPress: () => void;
  disabled?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.iconButton,
        {opacity: disabled ? 0.35 : pressed ? 0.65 : 1},
      ]}>
      <Text style={styles.icon}>{symbol}</Text>
    </Pressable>
  );
}

type NumericFieldKey =
  | 'context'
  | 'threads'
  | 'maxTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'repeatPenalty'
  | 'presencePenalty'
  | 'seed';

type NumericFieldSpec = {
  key: NumericFieldKey;
  label: string;
  keyboard: 'number-pad' | 'decimal-pad' | 'numbers-and-punctuation';
};

const RUNTIME_FIELDS: readonly NumericFieldSpec[] = [
  {
    key: 'context',
    label: 'Context tokens (reloads model)',
    keyboard: 'number-pad',
  },
  {
    key: 'threads',
    label: 'CPU threads (0 = Auto, reloads model)',
    keyboard: 'number-pad',
  },
];

const SAMPLING_FIELDS: readonly NumericFieldSpec[] = [
  {
    key: 'maxTokens',
    label: 'Maximum output tokens',
    keyboard: 'number-pad',
  },
  {
    key: 'temperature',
    label: 'Temperature (0–2)',
    keyboard: 'decimal-pad',
  },
  {
    key: 'topP',
    label: 'Top P (0–1]',
    keyboard: 'decimal-pad',
  },
  {
    key: 'topK',
    label: 'Top K (0 = off)',
    keyboard: 'number-pad',
  },
  {
    key: 'minP',
    label: 'Min P (0 = off)',
    keyboard: 'decimal-pad',
  },
  {
    key: 'repeatPenalty',
    label: 'Repeat penalty (1 = off)',
    keyboard: 'decimal-pad',
  },
  {
    key: 'presencePenalty',
    label: 'Presence penalty (-2–2)',
    keyboard: 'numbers-and-punctuation',
  },
  {
    key: 'seed',
    label: 'Seed (-1 = random)',
    keyboard: 'numbers-and-punctuation',
  },
];

function SettingsForm({
  styles,
  colors,
  scheme,
  currentTheme,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: Palette;
  scheme: 'light' | 'dark';
  currentTheme: ThemeMode;
}) {
  const [draft, setDraft] = useState(chat.settings);
  const [numbers, setNumbers] = useState<Record<NumericFieldKey, string>>({
    context: String(draft.context),
    threads: String(draft.threads),
    maxTokens: String(draft.maxTokens),
    temperature: String(draft.temperature),
    topP: String(draft.topP),
    topK: String(draft.topK),
    minP: String(draft.minP),
    repeatPenalty: String(draft.repeatPenalty),
    presencePenalty: String(draft.presencePenalty),
    seed: String(draft.seed),
  });
  const updateState = updates;
  const [updateRepo, setUpdateRepo] = useState(updates.repo);
  const [directIpaUrl, setDirectIpaUrl] = useState('');

  useEffect(() => {
    setDraft(current => ({...current, theme: currentTheme}));
  }, [currentTheme]);

  const checkUpdates = () => {
    void updates.check(true, updateRepo.trim() || DEFAULT_REPO);
  };

  const autoThreads = resolveThreadCount(0, chat.cpuInfo);

  const renderField = ({key, label, keyboard}: NumericFieldSpec) => (
    <View key={key}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        keyboardAppearance={scheme}
        placeholderTextColor={colors.placeholder}
        selectionColor={colors.accent}
        accessibilityLabel={label}
        style={styles.input}
        keyboardType={keyboard}
        value={numbers[key]}
        onChangeText={value => setNumbers(curr => ({...curr, [key]: value}))}
      />
    </View>
  );

  return (
    <ScrollView
      indicatorStyle={scheme === 'dark' ? 'white' : 'black'}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Appearance</Text>
      <View style={styles.row}>
        {(['system', 'light', 'dark'] as const).map(theme => {
          const active = (currentTheme ?? chat.settings.theme) === theme;
          return (
            <Button
              key={theme}
              title={
                (active ? '✓ ' : '') + theme[0].toUpperCase() + theme.slice(1)
              }
              color={active ? colors.text : colors.accent}
              onPress={() => {
                setDraft(curr => ({...curr, theme}));
                attempt(() => chat.updateSettings({...chat.settings, theme}));
              }}
            />
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>Model & Runtime</Text>
      {RUNTIME_FIELDS.map(renderField)}
      {chat.cpuInfo ? (
        <Text style={styles.path}>
          Detected CPU: {chat.cpuInfo.activeCores} cores
          {chat.cpuInfo.performanceCores > 0
            ? ` (${chat.cpuInfo.performanceCores} performance)`
            : ''}
          {' · '}Auto uses {autoThreads} thread{autoThreads === 1 ? '' : 's'}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text style={[styles.label, styles.flex]}>
          Use Metal GPU (reloads model)
        </Text>
        <Switch
          value={draft.gpu}
          onValueChange={gpu => setDraft({...draft, gpu})}
          disabled={chat.busy}
        />
      </View>

      <Text style={styles.sectionTitle}>Sampling</Text>
      {SAMPLING_FIELDS.map(renderField)}
      <Text style={styles.label}>System prompt</Text>
      <TextInput
        keyboardAppearance={scheme}
        placeholderTextColor={colors.placeholder}
        selectionColor={colors.accent}
        accessibilityLabel="System prompt"
        style={styles.input}
        multiline
        value={draft.systemPrompt}
        onChangeText={systemPrompt => setDraft({...draft, systemPrompt})}
      />
      <Button
        color={colors.accent}
        title="Save settings"
        disabled={chat.busy}
        onPress={() =>
          attempt(async () => {
            const next: Settings = {
              ...draft,
              context: parseFiniteSetting(numbers.context, 'Context tokens'),
              threads: parseFiniteSetting(numbers.threads, 'CPU threads'),
              maxTokens: parseFiniteSetting(
                numbers.maxTokens,
                'Maximum output tokens',
              ),
              temperature: parseFiniteSetting(
                numbers.temperature,
                'Temperature',
              ),
              topP: parseFiniteSetting(numbers.topP, 'Top P'),
              topK: parseFiniteSetting(numbers.topK, 'Top K'),
              minP: parseFiniteSetting(numbers.minP, 'Min P'),
              repeatPenalty: parseFiniteSetting(
                numbers.repeatPenalty,
                'Repeat penalty',
              ),
              presencePenalty: parseFiniteSetting(
                numbers.presencePenalty,
                'Presence penalty',
              ),
              seed: parseFiniteSetting(numbers.seed, 'Seed'),
            };
            await chat.updateSettings(next);
            Alert.alert('Settings saved');
          })
        }
      />
      <Text style={[styles.label, {marginTop: 16}]}>Updates</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={[styles.message, {fontWeight: '600'}]}>
            PocketPal 16
          </Text>
          <Text style={styles.path}>v{APP_VERSION}</Text>
        </View>
        <View style={[styles.row, {marginTop: 4}]}>
          <Text style={styles.message}>Engine</Text>
          <Text style={styles.path}>
            llama.cpp {PINNED_LLAMA_CPP_SHORT} ({PINNED_LLAMA_CPP_DATE})
          </Text>
        </View>

        <View style={{marginVertical: 8}}>
          {updateState.checking ? (
            <Text style={styles.status}>Checking GitHub for updates…</Text>
          ) : updateState.data ? (
            <>
              <Text style={styles.status}>
                {updateState.data.app?.hasUpdate
                  ? `Update available: v${updateState.data.app.latestVersion}`
                  : updateState.data.app
                    ? `No newer app release (installed v${APP_VERSION})`
                    : 'App update check failed'}
              </Text>
              {updateState.data.appError && (
                <Text style={styles.error}>{updateState.data.appError}</Text>
              )}
              {updateState.data.engine ? (
                <Text style={styles.status}>
                  Upstream llama.cpp:{' '}
                  {updateState.data.engine.status === 'identical'
                    ? 'Up to date with master'
                    : `${updateState.data.engine.commitsAhead} upstream commits ahead; ${updateState.data.engine.status} (latest: ${updateState.data.engine.latestCommit} on ${updateState.data.engine.latestDate})`}
                </Text>
              ) : updateState.data.engineError ? (
                <Text style={styles.error}>{updateState.data.engineError}</Text>
              ) : null}
              {updateState.data.engine?.latestMessage ? (
                <Text numberOfLines={2} style={styles.path}>
                  Latest commit: {updateState.data.engine.latestMessage}
                </Text>
              ) : null}
              {updateState.data.app?.releaseNotes ? (
                <Text numberOfLines={3} style={[styles.path, {marginTop: 4}]}>
                  Notes: {updateState.data.app.releaseNotes}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.status}>
              Tap "Check for updates" to query GitHub for new releases and
              engine status.
            </Text>
          )}
        </View>

        {updateState.error && (
          <Text style={styles.error}>{updateState.error}</Text>
        )}
        <Text style={styles.path}>
          Checks weekly while open, or when reopened after becoming due. Failed
          checks retry after one hour. Installation is your choice. Engine
          changes arrive inside a full native IPA release.
        </Text>
        {!!updateState.lastCheckedAt && (
          <Text style={styles.path}>
            Last check: {new Date(updateState.lastCheckedAt).toLocaleString()}
            {'\n'}Next check:{' '}
            {new Date(updateState.nextCheckAt).toLocaleString()}
          </Text>
        )}
        <View style={styles.updateActions}>
          <Button
            color={colors.accent}
            title={updateState.checking ? 'Checking…' : 'Check for updates'}
            disabled={updateState.checking || chat.busy}
            onPress={checkUpdates}
          />
          {updateState.data?.app?.downloadUrl ? (
            <Button
              color={colors.accent}
              title={
                updateState.data.app.hasUpdate
                  ? 'Update (TrollStore)'
                  : 'Reinstall (TrollStore)'
              }
              onPress={() =>
                attempt(() =>
                  installWithTrollStore(updateState.data!.app!.downloadUrl),
                )
              }
            />
          ) : null}
        </View>

        <View
          style={{
            marginTop: 12,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 8,
          }}>
          <Text style={styles.label}>Release Repository</Text>
          <TextInput
            keyboardAppearance={scheme}
            placeholderTextColor={colors.placeholder}
            selectionColor={colors.accent}
            accessibilityLabel="Release Repository"
            style={styles.input}
            placeholder={DEFAULT_REPO}
            value={updateRepo}
            onChangeText={setUpdateRepo}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Direct IPA URL (TrollStore)</Text>
        <TextInput
          keyboardAppearance={scheme}
          placeholderTextColor={colors.placeholder}
          selectionColor={colors.accent}
          accessibilityLabel="Direct IPA URL"
          style={styles.input}
          placeholder="https://.../PocketPal16.ipa"
          value={directIpaUrl}
          onChangeText={setDirectIpaUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          color={colors.accent}
          title="Install via TrollStore"
          disabled={!directIpaUrl.trim()}
          onPress={() => attempt(() => installWithTrollStore(directIpaUrl))}
        />
      </View>
    </ScrollView>
  );
}

function Main() {
  const [revision, redraw] = useReducer(value => value + 1, 0);
  const systemScheme = useColorScheme();
  const appearanceMode = chat.settings.theme;
  const scheme = resolveTheme(appearanceMode, systemScheme);
  const colors = palettes[scheme];
  const styles = themedStyles[scheme];
  useEffect(() => {
    try {
      Appearance.setColorScheme(
        appearanceMode === 'system' ? 'unspecified' : appearanceMode,
      );
    } catch {
      // Ignore in unsupported environments
    }
  }, [appearanceMode]);
  const [page, setPage] = useState<Page>('Chat');
  const [fullScreen, setFullScreen] = useState(false);
  const focusedChat = fullScreen && page === 'Chat';
  const [input, setInput] = useState('');
  const [picking, setPicking] = useState(false);
  const activeId = chat.activeId;
  const list = useRef<FlatList>(null);
  const followOutput = useRef(true);
  useEffect(() => {
    followOutput.current = true;
    list.current?.scrollToEnd({animated: false});
  }, [activeId, page]);
  useEffect(() => {
    if (page === 'Models' && chat.ready) {
      attempt(() => chat.refreshTelemetry());
    }
  }, [page]);
  useEffect(() => {
    const unsubscribe = chat.subscribe(redraw);
    const unsubscribeUpdates = updates.subscribe(redraw);
    updates.setActive(AppState.currentState === 'active');
    attempt(() => chat.initialize());
    const state = AppState.addEventListener('change', next => {
      updates.setActive(next === 'active');
      if (next === 'background') {
        attempt(() => chat.background());
      } else if (next === 'active') {
        chat.foreground();
      }
    });
    const memory = AppState.addEventListener('memoryWarning', () => {
      attempt(() => chat.handleMemoryWarning());
    });
    return () => {
      unsubscribe();
      unsubscribeUpdates();
      updates.setActive(false);
      state.remove();
      memory.remove();
    };
  }, []);
  const importFile = async () => {
    setPicking(true);
    try {
      const [file] = await pick({type: 'public.data', mode: 'import'});
      if (file) {
        await chat.importModel(file.uri, file.name ?? 'model.gguf');
      }
    } catch (error) {
      if (
        !isErrorWithCode(error) ||
        error.code !== errorCodes.OPERATION_CANCELED
      ) {
        throw error;
      }
    } finally {
      setPicking(false);
    }
  };
  if (!chat.ready) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar
          barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        />
        <Text style={styles.status}>
          {chat.error || 'Loading saved chats…'}
        </Text>
        {!!chat.error && (
          <Button
            color={colors.accent}
            title="Retry loading"
            onPress={() => attempt(() => chat.initialize())}
          />
        )}
      </SafeAreaView>
    );
  }

  const telemetryParts: string[] = [];
  if (chat.memoryInfo?.availableKnown) {
    telemetryParts.push(
      `Available RAM: ${formatMiB(chat.memoryInfo.availableBytes)}`,
    );
  }
  if (chat.memoryInfo && chat.memoryInfo.footprintBytes > 0) {
    telemetryParts.push(`App: ${formatMiB(chat.memoryInfo.footprintBytes)}`);
  }
  if (chat.cpuInfo && chat.cpuInfo.activeCores > 0) {
    telemetryParts.push(
      `CPU: ${chat.cpuInfo.activeCores}c${
        chat.cpuInfo.performanceCores > 0
          ? ` (${chat.cpuInfo.performanceCores}P)`
          : ''
      }`,
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar
        hidden={focusedChat}
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
      />
      {!focusedChat && (
        <>
          <View style={styles.tabs}>
            {(['Chat', 'Models', 'History', 'Settings'] as Page[]).map(name => (
              <Button
                color={colors.accent}
                key={name}
                title={name}
                disabled={page === name}
                onPress={() => setPage(name)}
              />
            ))}
          </View>
          <Text numberOfLines={2} style={styles.status}>
            {chat.loadedPath
              ? `${chat.loadedPath.split('/').pop()} · ${chat.backend}${
                  chat.activeThreads ? ` · ${chat.activeThreads}T` : ''
                }`
              : 'No model loaded'}
            {chat.loadingModel
              ? ' · Loading model…'
              : chat.busy
                ? ' · Working…'
                : ''}
          </Text>
          {updates.data?.app?.hasUpdate && (
            <Button
              color={colors.accent}
              title={`Update available: v${updates.data.app.latestVersion} — view in Settings`}
              onPress={() => setPage('Settings')}
            />
          )}
        </>
      )}
      {!!chat.error && (
        <Text
          selectable
          style={styles.error}
          onPress={() => {
            chat.error = '';
            chat.notify();
          }}>
          {chat.error}
        </Text>
      )}
      {!!chat.memoryWarningNote && (
        <Text style={styles.notice} onPress={chat.clearMemoryWarningNote}>
          {chat.memoryWarningNote}
        </Text>
      )}
      {page === 'Chat' && (
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          {!focusedChat && (
            <View style={styles.row}>
              <Text numberOfLines={1} style={styles.chatTitle}>
                {chat.active?.title ?? 'Chat'}
              </Text>
              <Button
                color={colors.accent}
                title="New chat"
                disabled={chat.busy}
                onPress={() => {
                  chat.newChat();
                  setInput('');
                  setFullScreen(false);
                }}
              />
              <Button
                color={colors.accent}
                title="Fullscreen"
                onPress={() => setFullScreen(true)}
              />
            </View>
          )}
          <FlatList
            indicatorStyle={scheme === 'dark' ? 'white' : 'black'}
            ref={list}
            style={styles.flex}
            data={chat.active?.messages.slice() ?? []}
            keyExtractor={(_, index) => String(index)}
            extraData={revision}
            scrollEventThrottle={100}
            onScroll={({
              nativeEvent: {contentOffset, contentSize, layoutMeasurement},
            }) => {
              followOutput.current =
                contentSize.height -
                  contentOffset.y -
                  layoutMeasurement.height <
                80;
            }}
            onContentSizeChange={() => {
              if (followOutput.current) {
                list.current?.scrollToEnd({animated: false});
              }
            }}
            renderItem={({item}) => (
              <View
                style={item.role === 'user' ? styles.user : styles.assistant}>
                <Text style={styles.label}>
                  {item.role === 'user' ? 'You' : 'Assistant'}
                </Text>
                <Text selectable style={styles.message}>
                  {item.content || '…'}
                </Text>
              </View>
            )}
          />
          <View style={styles.composer}>
            {focusedChat && (
              <IconButton
                styles={styles}
                label="Exit fullscreen"
                symbol="↙"
                onPress={() => setFullScreen(false)}
              />
            )}
            <IconButton
              styles={styles}
              label="Retry last response"
              symbol="↻"
              disabled={chat.busy || !chat.active?.messages.length}
              onPress={() => attempt(() => chat.retry())}
            />
            <TextInput
              keyboardAppearance={scheme}
              placeholderTextColor={colors.placeholder}
              selectionColor={colors.accent}
              accessibilityLabel="Message"
              style={[styles.input, styles.messageInput]}
              multiline
              placeholder="Message"
              value={input}
              onChangeText={text => {
                setInput(text);
                if (text.trim() && !input.trim()) {
                  attempt(() => chat.ensureModel());
                }
              }}
              editable={!chat.busy || chat.loadingModel}
            />
            {chat.generating ? (
              <IconButton
                styles={styles}
                label="Stop generation"
                symbol="■"
                onPress={() => attempt(() => chat.stop())}
              />
            ) : (
              <IconButton
                styles={styles}
                label="Send message"
                symbol="↑"
                disabled={chat.busy || !input.trim()}
                onPress={() => {
                  const text = input;
                  const isFirst = (chat.active?.messages.length ?? 0) === 0;
                  if (isFirst) {
                    setFullScreen(true);
                  }
                  attempt(async () => {
                    if (await chat.send(text)) {
                      setInput('');
                    }
                  });
                }}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      )}
      {page === 'Models' && (
        <ScrollView
          indicatorStyle={scheme === 'dark' ? 'white' : 'black'}
          contentContainerStyle={styles.content}>
          <View style={styles.row}>
            <Button
              color={colors.accent}
              title={picking ? 'Importing…' : 'Import GGUF'}
              disabled={chat.busy || picking}
              onPress={() => attempt(importFile)}
            />
            <Button
              color={colors.accent}
              title="Refresh"
              disabled={chat.busy}
              onPress={() => attempt(() => chat.refreshModels())}
            />
            <Button
              color={colors.accent}
              title="Unload"
              disabled={chat.busy || !chat.loadedPath}
              onPress={() => attempt(() => chat.unload())}
            />
          </View>
          {telemetryParts.length > 0 && (
            <Text style={styles.path}>{telemetryParts.join(' · ')}</Text>
          )}
          <Text style={styles.label}>
            SSH: copy GGUF files into this folder, then tap Refresh.
          </Text>
          <Text selectable style={styles.path}>
            {modelDirectory}
          </Text>
          <Button
            color={colors.accent}
            title="Copy folder path"
            onPress={() => NativeModules.RuntimeModule.copyText(modelDirectory)}
          />
          {!chat.models.length && (
            <Text style={styles.label}>No GGUF files imported yet.</Text>
          )}
          {chat.models.map(model => {
            const fitLabel = fitStatusLabel(model.fitStatus);
            const estText = model.estimatedBytes
              ? ` · ~${formatMiB(model.estimatedBytes)} at ${chat.settings.context} ctx`
              : '';
            return (
              <View key={model.path} style={styles.card}>
                <Text style={styles.message}>{model.name}</Text>
                <Text style={styles.status}>
                  {formatMiB(model.size)}
                  {estText}
                  {fitLabel ? ` · ${fitLabel}` : ''}
                </Text>
                <Button
                  color={colors.accent}
                  title={chat.loadedPath === model.path ? 'Loaded' : 'Load'}
                  disabled={
                    chat.busy || picking || chat.loadedPath === model.path
                  }
                  onPress={() => attempt(() => chat.loadModel(model.path))}
                />
              </View>
            );
          })}
        </ScrollView>
      )}
      {page === 'History' && (
        <FlatList
          indicatorStyle={scheme === 'dark' ? 'white' : 'black'}
          data={chat.sessions.slice()}
          keyExtractor={item => item.id}
          renderItem={({item}) => (
            <View style={styles.card}>
              <Text style={styles.message}>{item.title}</Text>
              <Text numberOfLines={1} style={styles.status}>
                {item.model.split('/').pop() || 'Empty chat'}
              </Text>
              <View style={styles.row}>
                <Button
                  color={colors.accent}
                  title="Open"
                  disabled={chat.busy}
                  onPress={() => {
                    chat.selectChat(item.id);
                    setInput('');
                    setFullScreen(false);
                    setPage('Chat');
                  }}
                />
                <Button
                  color={colors.accent}
                  title="Delete"
                  disabled={chat.busy}
                  onPress={() => attempt(() => chat.deleteChat(item.id))}
                />
              </View>
            </View>
          )}
        />
      )}
      {page === 'Settings' && (
        <SettingsForm
          styles={styles}
          colors={colors}
          scheme={scheme}
          currentTheme={chat.settings.theme}
        />
      )}
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
const createStyles = (colors: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: colors.background},
    flex: {flex: 1},
    tabs: {flexDirection: 'row', justifyContent: 'space-around'},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    updateActions: {
      marginTop: 8,
      gap: 8,
    },
    status: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      color: colors.secondary,
    },
    error: {
      padding: 12,
      color: colors.error,
      backgroundColor: colors.errorBackground,
    },
    notice: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: colors.text,
      backgroundColor: colors.assistant,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      fontSize: 13,
    },
    content: {padding: 12, gap: 12},
    sectionTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.text,
      marginTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    label: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: 10,
      fontSize: 16,
      color: colors.text,
    },
    messageInput: {flex: 1, maxHeight: 120},
    composer: {flexDirection: 'row', alignItems: 'center', padding: 8, gap: 4},
    iconButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    icon: {fontSize: 26, color: colors.accent},
    chatTitle: {
      color: colors.text,
      flex: 1,
      paddingLeft: 12,
      fontWeight: '600',
    },
    user: {
      margin: 8,
      marginLeft: 32,
      padding: 12,
      backgroundColor: colors.user,
      borderRadius: 8,
    },
    assistant: {
      margin: 8,
      marginRight: 24,
      padding: 12,
      backgroundColor: colors.assistant,
      borderRadius: 8,
    },
    message: {fontSize: 16, lineHeight: 23, color: colors.text},
    card: {
      margin: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
    },
    path: {fontSize: 12, color: colors.secondary},
  });

const themedStyles = {
  light: createStyles(palettes.light),
  dark: createStyles(palettes.dark),
};
