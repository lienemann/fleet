import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { IMAGE_TYPES, PDF_TYPE, type PromptAttachment } from "../shared/events.ts";

/** One content block of a user message, as the SDK types it. */
type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

const isImage = (type: string): type is (typeof IMAGE_TYPES)[number] =>
  (IMAGE_TYPES as readonly string[]).includes(type);

/**
 * Prompts waiting to be fed to a streaming-input query. Survives query restarts:
 * `stream()` hands out one consumer at a time and ends the previous one, so a
 * prompt is never swallowed by a dead query.
 */
export class InputQueue {
  private readonly buffer: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private generation = 0;

  /** Images and PDFs go to Claude as content blocks, ahead of the text as the API expects. */
  push(text: string, attachments: readonly PromptAttachment[] = []): void {
    const blocks = attachments.flatMap((file): ContentBlock[] => {
      if (file.mediaType === PDF_TYPE) {
        return [
          { type: "document", source: { type: "base64", media_type: PDF_TYPE, data: file.data } },
        ];
      }
      if (isImage(file.mediaType)) {
        return [
          {
            type: "image",
            source: { type: "base64", media_type: file.mediaType, data: file.data },
          },
        ];
      }
      return [];
    });
    const content = blocks.length === 0 ? text : [...blocks, { type: "text" as const, text }];
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
