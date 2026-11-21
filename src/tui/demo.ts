import type { Session } from '../domain.js';

/** Synthetic data only. Never mistaken for sessions read from the machine. */
export function demoSessions(workspace: string): Session[] {
  return [
    { id: 'demo-codex', nativeId: 'demo-codex', agent: 'codex', title: 'Finish the session picker', workspace,
      updatedAt: '2026-11-21T10:00:00Z', messages: [
        { id: 'c1', role: 'user', text: 'Build a quiet session picker with keyboard navigation.', status: 'complete' },
        { id: 'c2', role: 'assistant', text: 'Search and arrow-key navigation are the next steps.', status: 'interrupted' },
      ] },
    { id: 'demo-claude', nativeId: 'demo-claude', agent: 'claude', title: 'Investigate context handoff', workspace,
      updatedAt: '2026-11-20T12:00:00Z', messages: [
        { id: 'a1', role: 'user', text: 'Preserve constraints and show omitted history during transfer.', status: 'complete' },
      ] },
    { id: 'demo-other', nativeId: 'demo-other', agent: 'claude', title: 'Fix Unicode search', workspace: resolveDemoOther(workspace),
      updatedAt: '2026-11-19T12:00:00Z', messages: [
        { id: 'b1', role: 'user', text: 'Check résumé and multilingual history search.', status: 'complete' },
      ] },
  ];
}

function resolveDemoOther(workspace: string): string {
  return `${workspace}/another-demo-project`;
}
