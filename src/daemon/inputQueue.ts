import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PromptImage } from "../shared/events.ts";

/**
 * Prompts waiting to be fed to a streaming-input query. Survives query restarts:
 * `stream()` hands out one consumer at a time and ends the previous one, so a
 * prompt is never swallowed by a dead query.
 */
export class InputQueue {
  private readonly buffer: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private generation = 0;

  push(text: string, images: readonly PromptImage[] = []): void {
    const content =
      images.length === 0
        ? text
        : [
            ...images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            })),
            { type: "text" as const, text },
          ];
    this.buffer.push({
      type: "user",
      message: { role: "user", content },
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
