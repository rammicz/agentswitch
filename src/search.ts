import { resolve } from 'node:path';
import type { Session, SessionQuery } from './domain.js';

/** Demo/in-memory baseline; production indexing is a separate deliverable. */
export function searchSessions(sessions: readonly Session[], query: SessionQuery): Session[] {
  const needle = query.text.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (query.agent !== 'all' && session.agent !== query.agent) return false;
    if (query.scope === 'folder' && resolve(session.workspace) !== resolve(query.workspace)) return false;
    const haystack = [session.title, session.workspace, ...session.messages.map((item) => item.text)]
      .join('\n').toLocaleLowerCase();
    return haystack.includes(needle);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
