import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = new URL('./fixtures/agy/replay/evidence.json', import.meta.url);

test('agy 1.5.14 synthetic native evidence retains public replay and safe storage boundaries', async () => {
  const evidence = JSON.parse(await readFile(fixture, 'utf8'));
  assert.equal(evidence.version, '1.5.14');
  assert.equal(evidence.platform, 'linux-x64');
  assert.equal(evidence.isolation.externalNetwork, false);
  assert.equal(evidence.isolation.hostProfileMounted, false);
  assert.equal(evidence.acp.publicReplayComplete, true);
  assert.deepEqual(evidence.acp.publicReplay.map(({ role, text }) => [role, text]), [
    ['user', 'synthetic-request-cedar'], ['assistant', 'synthetic-reply-oak'],
  ]);
  assert.equal(evidence.acp.loadResult, 'ok');
  assert.equal(evidence.acp.initialize.agentInfo.version, '1.5.14');
  assert.equal(evidence.acp.initialize.agentCapabilities.loadSession, true);
  assert.deepEqual(evidence.acp.workspaceListIds, [evidence.acp.sessionId]);
  assert.deepEqual(evidence.acp.globalListIds, [evidence.acp.sessionId]);
  assert.ok(evidence.acp.replayedUpdateKinds.includes('agent_thought_chunk'));
  assert.ok(evidence.acp.excludedReplayKinds.includes('usage_update'));
  assert.deepEqual(evidence.acp.publicUpdateAnchors.map(({ update }) => update.sessionUpdate),
    ['user_message_chunk', 'agent_message_chunk']);
  assert.equal(evidence.acp.modelCallsDuringLoad, 0);
  assert.equal(evidence.acp.workspaceUnchangedAcrossSeparateListLoad, true);
  assert.deepEqual(evidence.acp.callbacksDuringLoad, []);
  assert.equal(evidence.storage.readOnlySnapshotUnchanged, true);
  assert.equal(evidence.acp.unavailableSyntheticSessionLoad.hasResult, true);
  assert.equal(evidence.acp.unavailableSyntheticSessionLoad.updateCount, 0);
  assert.equal(evidence.acp.unavailableSyntheticSessionLoad.modelCalls, 0);
  const active = evidence.activeAttachment;
  for (const state of [active.ownerOpenAfterCompletedTurn, active.ownerExitedAfterSecondTurn]) {
    assert.equal(state.listIdentityMatched, true);
    assert.equal(state.loadResult, 'ok');
    assert.equal(state.profileUnchanged, true);
    assert.equal(state.workspaceUnchanged, true);
    assert.equal(state.modelCallsDuringLoad, 0);
    assert.deepEqual(state.callbacks, []);
  }
  assert.deepEqual(active.ownerOpenAfterCompletedTurn.publicReplay, []);
  assert.equal(active.ownerOpenAfterCompletedTurn.updateCount, 0);
  assert.deepEqual(active.ownerExitedAfterSecondTurn.publicReplay.map(({ role }) => role),
    ['user', 'assistant', 'user', 'assistant']);
  assert.equal(evidence.storage.profiles.length, 4);
  for (const profile of evidence.storage.profiles) {
    assert.ok(profile.sessions.length > 0);
    for (const session of profile.sessions) {
      session.records = (await readFile(new URL(session.transcriptFixture, fixture), 'utf8'))
        .trimEnd().split('\n').map(line => JSON.parse(line));
      assert.match(session.summary.conversation_id, /^[a-f\d-]{36}$/);
      assert.equal(session.summary.status, 'CASCADE_RUN_STATUS_IDLE');
      assert.equal(session.summary.not_fully_idle, 0);
      assert.equal(session.summary.killed, 0);
      assert.equal(session.summary.step_count, session.records.length);
      assert.deepEqual(session.records.map(({ step_index }) => step_index), session.records.map((_, index) => index));
      assert.ok(session.records[0].content.startsWith(`<USER_REQUEST>\n${session.publicExpected[0].text}\n</USER_REQUEST>`));
      assert.equal(session.records[0].type, 'USER_INPUT');
      assert.equal(session.records[1].type, 'PLANNER_RESPONSE');
      assert.equal(session.records.at(-1).content, 'synthetic-reply-oak');
      assert.equal(session.records[0].status, 'DONE');
      assert.equal(session.records[1].status, 'DONE');
      assert.equal(session.records[0].created_at, '2026-01-01T00:00:00Z');
      assert.equal(session.summary.last_modified_time, '2026-01-01 00:00:00.000000000+00:00');
      assert.match(session.records[0].content, /<EXCLUDED_NATIVE_METADATA>/);
      assert.match(session.records[0].content, /<EXCLUDED_NATIVE_SETTINGS>/);
      assert.equal(session.publicExpected.at(-1).text, 'synthetic-reply-oak');
      assert.equal(session.records.at(-1).thinking, '<EXCLUDED_THINKING>');
      assert.doesNotMatch(JSON.stringify(session), /synthetic-discarded-thinking|The user changed setting|SYNTHETIC TOOL RESULT MUST NOT MIGRATE/);
      assert.equal('raw_summary' in session.summary, false);
    }
  }
  const print = evidence.storage.profiles.find(({ kind }) => kind === 'print');
  assert.equal(evidence.storage.profiles.find(({ kind }) => kind === 'acp').sessions[0].summary.conversation_id,
    evidence.acp.sessionId);
  assert.equal(print.sessions.length, 2);
  assert.deepEqual(print.sessions.map(({ summary }) => JSON.parse(summary.workspace_uris)).sort(),
    [['file:///work-one'], ['file:///work-two']]);
  const adversary = print.sessions.find(({ wrapperAmbiguous }) => wrapperAmbiguous);
  assert.match(adversary.publicExpected[0].text, /<\/USER_REQUEST>/);
  assert.equal(adversary.outgoingPolicy, 'refuse-ambiguous-wrapper');
  const tui = evidence.storage.profiles.find(({ kind }) => kind === 'tui');
  assert.equal(tui.sessions[0].summary.workspace_uris, '');
  assert.equal(tui.lastConversations['/work-tui'], tui.sessions[0].summary.conversation_id);
  assert.equal(tui.terminalConsumptionCertified, false);
  const tool = evidence.storage.profiles.find(({ kind }) => kind === 'tool').sessions[0];
  assert.deepEqual(tool.records.map(({ type }) => type),
    ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'PLANNER_RESPONSE']);
  assert.deepEqual(tool.records[1].tool_calls, [{ name: 'read_file', args: { Path: '<EXCLUDED_TOOL_ARGUMENT>' } }]);
  assert.equal(tool.records[2].content, '<EXCLUDED_UNCLASSIFIED_TOOL_RESULT>');
  assert.deepEqual(tool.omittedStepIndexes, [1, 2]);
  assert.equal(tool.outgoingPolicy, 'requires-tool-omission-policy');
  assert.deepEqual(tool.publicExpected.map(({ role }) => role), ['user', 'assistant']);
  assert.equal(evidence.limits.realAccount, 'unverified');
  assert.equal(evidence.limits.platformsOtherThanLinuxX64, 'unverified');
});
