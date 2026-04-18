import { TimeoutError } from '../errors.js';

const DEFAULT_SSE_TIMEOUT_MS = 300_000; // 5 minutes

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  extractContent: (json: unknown) => string | null,
  options: { timeoutMs?: number } = {}
): AsyncIterable<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSE_TIMEOUT_MS;
  const decoder = new TextDecoder();
  let buffer = '';
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    while (true) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new TimeoutError(
                `LLM response timeout — no data received for ${Math.round(timeoutMs / 1000)}s`,
              ),
            ),
          timeoutMs,
        );
      });

      let result: { done: boolean; value?: Uint8Array };
      try {
        result = await Promise.race([readPromise, timeoutPromise]);
      } catch (err) {
        // On timeout, flush any buffered data before throwing
        if (buffer.length > 0) {
          const { contents } = processSSEPart(buffer, extractContent);
          for (const content of contents) yield content;
        }
        throw err;
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      }

      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      // Process complete SSE events (split on double newline)
      // Also handle single newline separators (some providers use \n instead of \n\n)
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const { contents, done } = processSSEPart(part, extractContent);
        for (const content of contents) yield content;
        if (done) return;
      }

      // Check if buffer has accumulated single-line data events (Ollama sometimes sends data:\n instead of data:\n\n)
      if (buffer.includes('data: ') && buffer.includes('\n')) {
        const lines = buffer.split('\n');
        const remaining: string[] = [];
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            if (data) {
              try {
                const json = JSON.parse(data);
                const content = extractContent(json);
                if (content) yield content;
              } catch {
                // Not a complete JSON line yet — keep in buffer
                remaining.push(line);
              }
            }
          } else {
            remaining.push(line);
          }
        }
        buffer = remaining.join('\n');
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const { contents } = processSSEPart(buffer, extractContent);
      for (const content of contents) yield content;
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    reader.releaseLock();
  }
}

interface ProcessedPart {
  contents: string[];
  done: boolean;
}

function processSSEPart(
  part: string,
  extractContent: (json: unknown) => string | null
): ProcessedPart {
  const contents: string[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return { contents, done: true };
    if (!data) continue;

    try {
      const json = JSON.parse(data);
      const content = extractContent(json);
      if (content) contents.push(content);
    } catch {
      // Skip malformed JSON lines
    }
  }
  return { contents, done: false };
}
