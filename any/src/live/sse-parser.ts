export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id?: string;
  private retry?: number;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const emitted = this.processLine(line);
      if (emitted) events.push(emitted);
      newlineIndex = this.buffer.indexOf('\n');
    }
    return events;
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) {
      const emitted = this.processLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer);
      if (emitted) events.push(emitted);
      this.buffer = '';
    }
    const final = this.dispatch();
    if (final) events.push(final);
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry': {
        const retry = Number(value);
        if (Number.isInteger(retry) && retry >= 0) this.retry = retry;
        break;
      }
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (!this.data.length && !this.event) {
      this.resetEvent();
      return undefined;
    }
    const emitted: SseEvent = {
      event: this.event || 'message',
      data: this.data.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.resetEvent();
    return emitted;
  }

  private resetEvent(): void {
    this.event = '';
    this.data = [];
    this.retry = undefined;
  }
}

export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void | Promise<void>,
  options: { signal?: AbortSignal; maxBytes?: number; onData?: (bytes: number) => void } = {},
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let bytes = 0;
  let completed = false;
  const abort = (): void => { void reader.cancel(options.signal?.reason).catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      if (value) {
        bytes += value.byteLength;
        if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) throw new Error('SSE 响应超过 2 MiB 大小限制');
        if (value.byteLength) options.onData?.(value.byteLength);
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          await onEvent(event);
        }
      }
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          for (const event of parser.push(tail)) await onEvent(event);
        }
        break;
      }
    }
    for (const event of parser.finish()) await onEvent(event);
    completed = true;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseSseJson(event: SseEvent): Record<string, unknown> | undefined {
  if (!event.data || event.data === '[DONE]') return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
