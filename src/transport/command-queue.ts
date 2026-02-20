/**
 * CommandQueue — serial execution queue for transports.
 *
 * Ensures only one command runs at a time on a transport.
 * Critical for SSH (shared stdin/stdout) and defensive for Docker.
 */

export class CommandQueue {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private processing = false;

  /**
   * Enqueue a function for serial execution.
   * Returns a Promise that resolves/rejects with the function's result.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processNext();
    });
  }

  /**
   * Drain the queue, rejecting all pending items with the given error.
   * Used when a connection dies.
   */
  drain(error: Error): void {
    const items = this.queue.splice(0);
    for (const item of items) {
      item.reject(error);
    }
    this.processing = false;
  }

  /**
   * Number of items waiting in the queue (not including the currently executing one).
   */
  get pending(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const item = this.queue.shift()!;

    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}
