export const CONTINUATION_PROTOCOL_VERSION = 'continuation-v2.1-screen-20261024';

export const registeredTasks = Object.freeze({
  'task-a': Object.freeze({
    id: 'task-a',
    title: 'One natural compaction, then continue and fix the buggy pagination code',
    workInputTokens: 16_384,
    expectedMinCompactions: 1,
    dryRunDocs: 9,
  }),
  'task-b': Object.freeze({
    id: 'task-b',
    title: 'Two natural compactions: retain the early folded legacy constraint and deliver',
    workInputTokens: 16_384,
    expectedMinCompactions: 2,
    dryRunDocs: 15,
  }),
});

export const registeredTask = id => {
  const task = registeredTasks[id];
  if (!task) throw new Error(`unregistered continuation task ${JSON.stringify(id)}`);
  return task;
};
