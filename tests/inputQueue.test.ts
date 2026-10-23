import { expect, it } from "vitest";
import { InputQueue } from "../src/daemon/inputQueue.ts";

const text = (message: { message: { content: unknown } }) => message.message.content;

it("delivers buffered prompts in order, even those pushed before consuming", async () => {
  const queue = new InputQueue();
  queue.push("one");
  const stream = queue.stream();
  queue.push("two");
  expect(text((await stream.next()).value as never)).toBe("one");
  expect(text((await stream.next()).value as never)).toBe("two");
});

it("hands prompts to the newest consumer only", async () => {
  const queue = new InputQueue();
  const old = queue.stream();
  const oldNext = old.next();
  const fresh = queue.stream();
  expect((await oldNext).done).toBe(true);
  queue.push("after restart");
  expect(text((await fresh.next()).value as never)).toBe("after restart");
});

it("sends images ahead of the text, as the API expects", async () => {
  const queue = new InputQueue();
  queue.push("what is this?", [{ name: "dot.png", mediaType: "image/png", data: "iVBORw0KGgo=" }]);
  const message = (await queue.stream().next()).value as { message: { content: unknown } };
  expect(message.message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "text", text: "what is this?" },
  ]);
});
