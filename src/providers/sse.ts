export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  extractContent: (json: unknown) => string | null
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      // Timeout per-read: 5 minutes (Ollama can be slow on large prompts)
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) =>
        setTimeout(() => reject(new Error('LLM response timeout — no data received for 5 minutes')), 300000)
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        result = await Promise.race([readPromise, timeoutPromise]);
      } catch (err) {
        // On timeout, check if we got any data at all
        if (buffer.length > 0) {
          // Process remaining buffer before throwing
          yield* processBuffer(buffer, extractContent);
        }
        throw err;
      }

      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      // Process complete SSE events (split on double newline)
      // Also handle single newline separators (some providers use \n instead of \n\n)
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        yield* processSSEPart(part, extractContent);
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
      yield* processBuffer(buffer, extractContent);
    }
  } finally {
    reader.releaseLock();
  }
}

function* processSSEPart(
  part: string,
  extractContent: (json: unknown) => string | null
): Generator<string> {
  for (const line of part.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return;
    if (!data) continue;

    try {
      const json = JSON.parse(data);
      const content = extractContent(json);
      if (content) yield content;
    } catch {
      // Skip malformed JSON lines
    }
  }
}

function* processBuffer(
  buffer: string,
  extractContent: (json: unknown) => string | null
): Generator<string> {
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]' || !data) continue;
    try {
      const json = JSON.parse(data);
      const content = extractContent(json);
      if (content) yield content;
    } catch { /* skip */ }
  }
}
