/**
 * Small async queue bridging a push-based SDK stream to the pull-based
 * AsyncIterable the AgentAdapter contract exposes. Buffers while nobody
 * is consuming; `end()` (optionally with a terminal error) closes it.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private failure: ((err: unknown) => void)[] = [];
  private done = false;
  private error: unknown;

  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.failure.shift();
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const fail = this.failure.shift()!;
      if (error !== undefined) fail(error);
      else waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) {
          if (this.error !== undefined) return Promise.reject(this.error);
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.failure.push(reject);
        });
      },
    };
  }
}
