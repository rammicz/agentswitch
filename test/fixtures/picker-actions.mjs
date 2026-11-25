// PTY driver actions for the session picker, shared by the tests that drive the real CLI.

/**
 * Types a query and waits until the list shows its results. The picker ignores Enter while a search replaces the
 * results, and busy frames never show "Enter preview", so the first "Enter preview" after the query's echo is the
 * frame where Enter opens a result of this query. An empty result shows no "Enter preview" either; pass
 * "No matching sessions" as `until` when no result is expected.
 */
export const search = (text, until = 'Enter preview') => [{ send: text }, { wait: `Search: ${text}` }, { wait: until }];

/** Opens the first result of a query and its target choice. */
export const open = (text) => [...search(text), { send: '\r' }, { wait: 'Enter choose target' }, { send: '\r' }, { wait: 'C edit request' }];
