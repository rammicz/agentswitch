import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions } from '../dist/search.js';
import { demoSessions } from '../dist/tui/demo.js';

const workspace = '/fixture/project';
const sessions = demoSessions(workspace);
const query = { text: '', agent: 'all', scope: 'folder', workspace };

test('folder scope excludes other workspaces; global combines agent histories', () => {
  assert.deepEqual(searchSessions(sessions, query).map(s => s.id), ['demo-codex', 'demo-claude']);
  assert.equal(searchSessions(sessions, { ...query, scope: 'global' }).length, 3);
  assert.equal(searchSessions(sessions, { ...query, agent: 'claude' }).length, 1);
});

test('search reaches message text and combines source agent and scope', () => {
  assert.equal(searchSessions(sessions, { ...query, text: 'OMITTED' })[0]?.id, 'demo-claude');
  assert.equal(searchSessions(sessions, { ...query, text: 'omitted', agent: 'codex' }).length, 0);
  assert.equal(searchSessions(sessions, { ...query, text: 'résumé', scope: 'global' })[0]?.id, 'demo-other');
});
