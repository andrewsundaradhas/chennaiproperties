// Minimal structured logger. Never pass secrets or raw message bodies to it.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? 'info') as Level | 'silent';
  return order[lvl] ?? order.info;
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
