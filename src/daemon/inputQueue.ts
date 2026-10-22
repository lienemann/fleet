import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Prompts waiting to be fed to a streaming-input query. Survives query restarts:
 * `stream()` hands out one consumer at a time and ends the previous one, so a
 * prompt is never swallowed by a dead query.
 */
export class InputQueue {
  private readonly buffer: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private generation = 0;

  push(text: string): void {
    this.buffer.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  stream(): AsyncGenerator<SDKUserMessage, void> {
    const mine = ++this.generation;
    this.wake?.(); // ends the previous consumer
    return this.consume(mine);
  }

  /** Ends the current consumer without starting a new one. */
  close(): void {
    this.generation++;
    this.wake?.();
  }

  private async *consume(mine: number): AsyncGenerator<SDKUserMessage, void> {
    while (this.generation === mine) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
      } else {
        let release: (() => void) | undefined;
        await new Promise<void>((resolve) => {
          release = resolve;
          this.wake = resolve;
        });
        if (this.wake === release) this.wake = undefined;
      }
    }
  }
}
