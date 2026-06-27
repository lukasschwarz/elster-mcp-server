export type SessionKind = 'USTVA' | 'EUR' | 'EST' | 'SYNC';

export type SessionStatus =
  | 'STARTING' | 'LOGGING_IN' | 'OPENING_FORM' | 'FILLING_PAGES'
  | 'PRUEFUNG' | 'AWAITING_CONFIRM' | 'AWAITING_REVIEW' | 'SUBMITTING'
  | 'SAVING' | 'SAVED' | 'DONE' | 'ERROR' | 'CANCELLED';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  progress: string[];
  errors?: string[];
  screenshotPath?: string;
  result?: Record<string, unknown>;
  createdAt: number;
}

export interface InternalSession extends SessionInfo {
  _confirmResolve?: () => void;
  _confirmReject?: (e: Error) => void;
  _resultResolve?: (r: Record<string, unknown>) => void;
  _resultReject?: (e: Error) => void;
  _doneResolve?: () => void;
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();

  create(kind: SessionKind): InternalSession {
    const id = `${kind.toLowerCase()}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const session: InternalSession = {
      id, kind, status: 'STARTING', progress: [], createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): InternalSession | null {
    return this.sessions.get(id) ?? null;
  }

  view(id: string): SessionInfo | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      id: s.id, kind: s.kind, status: s.status,
      progress: [...s.progress], errors: s.errors,
      screenshotPath: s.screenshotPath, result: s.result, createdAt: s.createdAt,
    };
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => this.view(s.id)!).filter(Boolean);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  scheduleCleanup(id: string, ms: number = 60 * 60 * 1000): void {
    setTimeout(() => this.sessions.delete(id), ms);
  }
}

export const sessionManager = new SessionManager();
