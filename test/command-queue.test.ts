import { describe, it, expect } from "vitest";
import { CommandQueue } from "../src/transport/command-queue.js";

describe("CommandQueue", () => {
  it("executes a single task", async () => {
    const queue = new CommandQueue();
    const result = await queue.enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("serializes concurrent tasks", async () => {
    const queue = new CommandQueue();
    const order: number[] = [];

    const [a, b, c] = await Promise.all([
      queue.enqueue(async () => { order.push(1); return "a"; }),
      queue.enqueue(async () => { order.push(2); return "b"; }),
      queue.enqueue(async () => { order.push(3); return "c"; }),
    ]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(c).toBe("c");
    expect(order).toEqual([1, 2, 3]); // strictly sequential
  });

  it("propagates errors without breaking the queue", async () => {
    const queue = new CommandQueue();

    await expect(
      queue.enqueue(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    // Queue still works after error
    const result = await queue.enqueue(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("drain rejects all pending items", async () => {
    const queue = new CommandQueue();

    // Enqueue a slow task + a pending task
    const slow = queue.enqueue(
      () => new Promise((resolve) => setTimeout(() => resolve("slow"), 100)),
    );
    const pending = queue.enqueue(() => Promise.resolve("pending"));

    // Drain immediately — slow is executing, pending is queued
    queue.drain(new Error("connection lost"));

    // pending should be rejected
    await expect(pending).rejects.toThrow("connection lost");

    // slow was already executing — it completes normally
    const slowResult = await slow;
    expect(slowResult).toBe("slow");
  });

  it("reports pending count", async () => {
    const queue = new CommandQueue();

    // Start a blocking task
    let unblock: () => void;
    const blocker = new Promise<void>((resolve) => { unblock = resolve; });

    const p1 = queue.enqueue(() => blocker.then(() => "done"));
    const p2 = queue.enqueue(() => Promise.resolve("p2"));
    const p3 = queue.enqueue(() => Promise.resolve("p3"));

    expect(queue.pending).toBe(2); // p2 and p3 are pending

    unblock!();
    await Promise.all([p1, p2, p3]);

    expect(queue.pending).toBe(0);
  });
});
