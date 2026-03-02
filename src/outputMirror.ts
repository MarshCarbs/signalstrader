import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_OUTPUT_FILE = path.join(process.cwd(), 'logs', 'terminal_output.txt');

function toTextChunk(chunk: unknown, encoding?: BufferEncoding): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString(encoding || 'utf8');
  }
  return String(chunk);
}

export function setupProcessOutputMirror(outputFile: string = DEFAULT_OUTPUT_FILE): string {
  const outputDir = path.dirname(outputFile);
  fs.mkdirSync(outputDir, { recursive: true });

  const stream = fs.createWriteStream(outputFile, { flags: 'a', encoding: 'utf8' });
  stream.write(`\n===== process start ${new Date().toISOString()} =====\n`);

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown as (chunk: unknown, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => boolean) =
    (chunk: unknown, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean => {
      stream.write(toTextChunk(chunk, encoding));
      return originalStdoutWrite(chunk as any, encoding as any, cb as any);
    };

  (process.stderr.write as unknown as (chunk: unknown, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => boolean) =
    (chunk: unknown, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean => {
      stream.write(toTextChunk(chunk, encoding));
      return originalStderrWrite(chunk as any, encoding as any, cb as any);
    };

  process.on('exit', () => {
    try {
      stream.end(`\n===== process exit ${new Date().toISOString()} =====\n`);
    } catch {
      // ignore
    }
  });

  return outputFile;
}
