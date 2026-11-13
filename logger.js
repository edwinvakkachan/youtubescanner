'use strict';

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const minimumLevel = levels[configuredLevel] || levels.info;

function write(level, event, details = {}) {
  if (levels[level] < minimumLevel) return;
  const record = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: 'youtube-scanner',
    event,
    ...details
  };
  const output = `${JSON.stringify(record)}\n`;
  if (level === 'error' || level === 'warn') process.stderr.write(output);
  else process.stdout.write(output);
}

function gemini(event, details = {}) {
  if (levels.info < minimumLevel) return;
  const colors = { REQUEST: '\x1b[35m', ACCEPTED: '\x1b[32m', REJECTED: '\x1b[33m', ERROR: '\x1b[31m' };
  const color = colors[event] || '\x1b[36m';
  const record = `${new Date().toISOString()} [GEMINI AI] [${event}] ${JSON.stringify(details)}`;
  const output = `${color}${record}\x1b[0m\n`;
  if (event === 'ERROR') process.stderr.write(output);
  else process.stdout.write(output);
}

module.exports = {
  debug: (event, details) => write('debug', event, details),
  info: (event, details) => write('info', event, details),
  warn: (event, details) => write('warn', event, details),
  error: (event, details) => write('error', event, details),
  gemini
};
