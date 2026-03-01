type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function format(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] ${level} ${message}`;
}

export function logInfo(message: string): void {
  console.log(format('INFO', message));
}

export function logWarn(message: string): void {
  console.warn(format('WARN', message));
}

export function logError(message: string): void {
  console.error(format('ERROR', message));
}
