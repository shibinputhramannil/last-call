// Plain one-line logs with a timestamp and level, readable in a terminal and in
// hosting dashboards. Never log seat tokens or chat text.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_LEVELS = Object.freeze(Object.keys(LEVELS));

function formatValue(value) {
  if (value instanceof Error) return JSON.stringify(value.stack || value.message);
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

export function createLogger(level = 'info', out = console) {
  const min = LEVELS[level] ?? LEVELS.info;
  const make = (name, write) => (message, fields) => {
    if (LEVELS[name] < min) return;
    const extra = fields
      ? ' ' + Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${formatValue(v)}`)
          .join(' ')
      : '';
    write.call(out, `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}${extra}`);
  };
  return {
    debug: make('debug', out.log),
    info: make('info', out.log),
    warn: make('warn', out.warn),
    error: make('error', out.error),
  };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
