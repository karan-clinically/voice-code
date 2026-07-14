// What a session is waiting on you for. Harness-owned sessions carry a specific kind
// (services/attention.js); sessions the harness doesn't own only carry Claude's own
// 'unread'. Shared by the sessions list, the switcher drawer and the in-session banner
// so one session reads the same wherever it appears.
export const ATTENTION_TITLE = {
  input: 'Needs your input',
  finished: 'Finished — result waiting',
  failed: 'Last turn errored',
  unread: 'Unread activity',
};

// Short form for tight spots (banner, drawer row).
export const ATTENTION_SHORT = {
  input: 'Needs input',
  finished: 'Finished',
  failed: 'Errored',
  unread: 'Unread',
};

export const attentionOf = (it) => it.attention || (it.unread ? 'unread' : null);

// The banner only fires on the three pings the harness itself detects. 'unread' is a
// passive marker on sessions we don't drive, so it stays a dot in the list.
export const isAlert = (it) => ['input', 'finished', 'failed'].includes(it.attention);
