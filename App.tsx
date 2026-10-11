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

type Page = 'Chat' | 'Models' | 'History' | 'Settings';
const attempt = (work: () => Promise<unknown>) => {
  work().catch(chat.report);
};

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
        {(['system', 'light', 'dark'] as const).map(theme => (
          <Button
            key={theme}
            title={theme[0].toUpperCase() + theme.slice(1)}
            color={colors.accent}
            disabled={draft.theme === theme}
            onPress={() => setDraft({...draft, theme})}
          />
        ))}
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
        <Text style={styles.label}>
          Try Metal GPU; CPU if unsupported (reloads model)
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
    </ScrollView>
  );
}

function Main() {
  const systemScheme = useColorScheme();
  const appearanceMode = chat.settings.theme;
  const scheme = resolveTheme(appearanceMode, systemScheme);
  const colors = palettes[scheme];
  const styles = themedStyles[scheme];
  useEffect(() => {
    Appearance.setColorScheme(
      appearanceMode === 'system' ? 'unspecified' : appearanceMode,
    );
  }, [scheme, appearanceMode]);
  const [revision, redraw] = useReducer(value => value + 1, 0);
  const [page, setPage] = useState<Page>('Chat');
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
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
      />
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
              }}
            />
          </View>
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
                {!!item.content && (
                  <Button
                    color={colors.accent}
                    title="Copy"
                    onPress={() =>
                      NativeModules.RuntimeModule.copyText(item.content)
                    }
                  />
                )}
              </View>
            )}
          />
          <Button
            color={colors.accent}
            title="Retry last response"
            disabled={
              chat.busy || !chat.loadedPath || !chat.active?.messages.length
            }
            onPress={() => attempt(() => chat.retry())}
          />
          <View style={styles.composer}>
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
              <Button
                color={colors.accent}
                title="Stop"
                onPress={() => attempt(() => chat.stop())}
              />
            ) : (
              <Button
                color={colors.accent}
                title="Send"
                disabled={chat.busy || !chat.loadedPath || !input.trim()}
                onPress={() => {
                  const text = input;
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
    composer: {flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8},
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
