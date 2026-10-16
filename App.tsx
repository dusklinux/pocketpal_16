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
import {Settings} from './src/chat';
import {Palette, palettes, resolveTheme} from './src/theme';
import {
  APP_VERSION,
  checkAllUpdates,
  CombinedUpdateStatus,
  installWithTrollStore,
  PINNED_LLAMA_CPP_SHORT,
  PINNED_LLAMA_CPP_DATE,
} from './src/updater';

type Page = 'Chat' | 'Models' | 'History' | 'Settings';
const attempt = (work: () => Promise<unknown>) => {
  work().catch(chat.report);
};

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

function SettingsForm({
  styles,
  colors,
  scheme,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: Palette;
  scheme: 'light' | 'dark';
}) {
  const [draft, setDraft] = useState(chat.settings);
  const [numbers, setNumbers] = useState({
    context: String(draft.context),
    maxTokens: String(draft.maxTokens),
    temperature: String(draft.temperature),
    topP: String(draft.topP),
  });
  const [updateState, setUpdateState] = useState<{
    checking: boolean;
    data: CombinedUpdateStatus | null;
  }>({checking: false, data: null});
  const [directIpaUrl, setDirectIpaUrl] = useState('');

  useEffect(() => {
    setDraft(current => ({...current, theme: chat.settings.theme}));
  }, []);

  const checkUpdates = () => {
    setUpdateState({checking: true, data: null});
    attempt(async () => {
      const data = await checkAllUpdates(APP_VERSION);
      setUpdateState({checking: false, data});
    });
  };

  const fields = [
    ['context', 'Context tokens (reloads model)'],
    ['maxTokens', 'Maximum output tokens'],
    ['temperature', 'Temperature'],
    ['topP', 'Top P'],
  ] as const;
  return (
    <ScrollView
      indicatorStyle={scheme === 'dark' ? 'white' : 'black'}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Appearance</Text>
      <View style={styles.row}>
        {(['system', 'light', 'dark'] as const).map(theme => {
          const active = chat.settings.theme === theme;
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
      {fields.map(([key, label]) => (
        <View key={key}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            keyboardAppearance={scheme}
            placeholderTextColor={colors.placeholder}
            selectionColor={colors.accent}
            accessibilityLabel={label}
            style={styles.input}
            keyboardType="decimal-pad"
            value={numbers[key]}
            onChangeText={value => setNumbers({...numbers, [key]: value})}
          />
        </View>
      ))}
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
              context: Number(numbers.context),
              maxTokens: Number(numbers.maxTokens),
              temperature: Number(numbers.temperature),
              topP: Number(numbers.topP),
            };
            await chat.updateSettings(next);
            Alert.alert('Settings saved');
          })
        }
      />
      <Text style={[styles.label, {marginTop: 16}]}>
        Updates & Engine Status
      </Text>
      <View style={styles.card}>
        <Text style={styles.message}>
          llama.cpp {PINNED_LLAMA_CPP_SHORT} ({PINNED_LLAMA_CPP_DATE})
        </Text>
        <Text style={styles.status}>
          {updateState.checking
            ? 'Querying GitHub API…'
            : updateState.data?.engine
              ? `${updateState.data.engine.commitsAhead} commits behind master (latest: ${updateState.data.engine.latestCommit} on ${updateState.data.engine.latestDate})`
              : updateState.data?.engineError
                ? updateState.data.engineError
                : 'Tap Check to cross-reference upstream llama.cpp commits'}
        </Text>
        {updateState.data?.engine?.latestMessage ? (
          <Text numberOfLines={2} style={styles.path}>
            Latest: {updateState.data.engine.latestMessage}
          </Text>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.message}>PocketPal 16 v{APP_VERSION}</Text>
        <Text style={styles.status}>
          {updateState.checking
            ? 'Checking GitHub for releases…'
            : updateState.data?.app
              ? updateState.data.app.hasUpdate
                ? `Update available: v${updateState.data.app.latestVersion}`
                : `Up to date (latest: v${updateState.data.app.latestVersion})`
              : updateState.data?.appError
                ? updateState.data.appError
                : 'Check GitHub releases for IPA builds'}
        </Text>
        {updateState.data?.app?.releaseNotes ? (
          <Text numberOfLines={3} style={styles.path}>
            {updateState.data.app.releaseNotes}
          </Text>
        ) : null}
        <View style={styles.row}>
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
    const unsubscribe = chat.subscribe(redraw);
    attempt(() => chat.initialize());
    const state = AppState.addEventListener('change', next => {
      if (next === 'background') {
        attempt(() => chat.background());
      } else if (next === 'active') {
        chat.foreground();
      }
    });
    const memory = AppState.addEventListener('memoryWarning', () => {
      if (!chat.busy) {
        attempt(() => chat.unload());
      }
    });
    return () => {
      unsubscribe();
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
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar
        hidden={focusedChat}
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
      />
      {!focusedChat && (
        <>
          <Text style={styles.title}>PocketPal 16</Text>
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
              ? `${chat.loadedPath.split('/').pop()} · ${chat.backend}`
              : 'No model loaded'}
            {chat.busy ? ' · Working…' : ''}
          </Text>
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
              disabled={
                chat.busy || !chat.loadedPath || !chat.active?.messages.length
              }
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
              onChangeText={setInput}
              editable={!chat.busy}
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
                disabled={chat.busy || !chat.loadedPath || !input.trim()}
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
          {chat.models.map(model => (
            <View key={model.path} style={styles.card}>
              <Text style={styles.message}>{model.name}</Text>
              <Text style={styles.status}>
                {(model.size / 1024 ** 2).toFixed(0)} MiB
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
          ))}
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
        <SettingsForm styles={styles} colors={colors} scheme={scheme} />
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
    title: {
      fontSize: 22,
      fontWeight: '600',
      paddingHorizontal: 12,
      paddingTop: 8,
      color: colors.text,
    },
    tabs: {flexDirection: 'row', justifyContent: 'space-around'},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    content: {padding: 12, gap: 12},
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
