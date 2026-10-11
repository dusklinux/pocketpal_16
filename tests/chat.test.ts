import {
  defaults,
  fitMessages,
  Message,
  readSaved,
  SaveQueue,
  validateSettings,
} from '../src/chat';

test('starts with empty history and validates generation limits', () => {
  expect(readSaved(null)).toEqual({sessions: [], settings: defaults});
  expect(() => validateSettings({...defaults, temperature: NaN})).toThrow();
  expect(() => validateSettings({...defaults, maxTokens: 1024})).toThrow();
  expect(() => validateSettings({...defaults, context: 512.5})).toThrow();
});
test('damaged history is rejected instead of silently overwritten', () => {
  expect(() => readSaved('{broken')).toThrow();
  expect(() =>
    readSaved(JSON.stringify({sessions: [{id: 'x'}], settings: defaults})),
  ).toThrow();
});
test('trims whole old turns while keeping system and latest message; does not mutate saved history', async () => {
  const history: Message[] = [
    {role: 'user', content: 'old'},
    {role: 'assistant', content: 'answer'},
    {role: 'user', content: 'latest'},
  ];
  const snapshot = JSON.stringify(history);
  const prompt = await fitMessages(history, defaults, async value =>
    value.length > 2 ? 900 : 100,
  );
  expect(prompt).toEqual([
    {role: 'system', content: defaults.systemPrompt},
    history[2],
  ]);
  expect(JSON.stringify(history)).toBe(snapshot);
});
test('rejects oversized latest input without truncating it', async () => {
  await expect(
    fitMessages(
      [{role: 'user', content: 'too long'}],
      defaults,
      async () => 2000,
    ),
  ).rejects.toThrow('context budget');
});
test('queued saves capture snapshots, remain ordered, and recover after a failure', async () => {
  const values: string[] = [];
  let first = true;
  const queue = new SaveQueue(async raw => {
    values.push(raw);
    if (first) {
      first = false;
      throw new Error('disk full');
    }
  });
  const state = {sessions: [], settings: {...defaults}};
  const one = queue.save(state);
  state.settings.temperature = 1;
  const two = queue.save(state);
  await expect(one).rejects.toThrow('disk full');
  await two;
  expect(values.map(raw => JSON.parse(raw).settings.temperature)).toEqual([
    0.7, 1,
  ]);
});

test('rejects histories with repeated user roles and preserves empty assistant turns', async () => {
  const sessions = [
    {
      id: 's',
      title: 'x',
      model: 'model.gguf',
      messages: [
        {role: 'user', content: 'x'},
        {role: 'user', content: 'y'},
      ],
    },
  ];
  expect(() =>
    readSaved(JSON.stringify({sessions, settings: defaults})),
  ).toThrow('Saved message');
  const messages: Message[] = [
    {role: 'user', content: 'x'},
    {role: 'assistant', content: ''},
    {role: 'user', content: 'y'},
  ];
  expect(
    await fitMessages(
      messages,
      {...defaults, systemPrompt: ''},
      async () => 10,
    ),
  ).toEqual(messages);
});
