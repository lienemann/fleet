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
