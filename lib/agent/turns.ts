interface TurnState {
  authorUserId: string;
  stepStartedAt: number;
  modelId: string | null;
  actionStartedAt: Map<string, number>;
  lastUserContent: string | null;
}

const globalTurns = globalThis as unknown as { manfrodTurns?: Map<string, TurnState> };
globalTurns.manfrodTurns ??= new Map();
const turns = globalTurns.manfrodTurns;

export function startTurn(sessionId: string, authorUserId: string, lastUserContent: string | null = null): TurnState {
  const state: TurnState = {
    authorUserId,
    stepStartedAt: Date.now(),
    modelId: null,
    actionStartedAt: new Map(),
    lastUserContent,
  };
  turns.set(sessionId, state);
  return state;
}

export function turnFor(sessionId: string): TurnState | undefined {
  return turns.get(sessionId);
}

export function endTurn(sessionId: string): void {
  turns.delete(sessionId);
}

const authorsBySession = new Map<string, string>();

export function setActiveAuthor(sessionKey: string, userId: string): void {
  authorsBySession.set(sessionKey, userId);
}

export function activeAuthor(sessionKey: string): string | undefined {
  return authorsBySession.get(sessionKey);
}

export function clearActiveAuthor(sessionKey: string): void {
  authorsBySession.delete(sessionKey);
}
