type Level = 'debug' | 'info' | 'warn' | 'error';

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, msg: string): void {
  process.stderr.write(`[${ts()}] [${level.toUpperCase()}] ${msg}\n`);
}

export const log = {
  debug: (msg: string) => emit('debug', msg),
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),
};
