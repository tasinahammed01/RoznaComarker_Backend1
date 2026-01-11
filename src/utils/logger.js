function format(level, message) {
  const ts = new Date().toISOString();
  return `[${ts}] ${level}: ${message}`;
}

function toMessage(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = {
  info(message) {
    console.log(format('INFO', toMessage(message)));
  },
  warn(message) {
    console.warn(format('WARN', toMessage(message)));
  },
  error(message) {
    console.error(format('ERROR', toMessage(message)));
  },
  debug(message) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(format('DEBUG', toMessage(message)));
    }
  }
};

module.exports = logger;
