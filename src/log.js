'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(fmt).join(' ')}\n`);
}

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function logger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

logger.setLevel = (level) => {
  if (!LEVELS[level]) throw new Error(`unknown log level: ${level}`);
  threshold = LEVELS[level];
};

module.exports = logger;
