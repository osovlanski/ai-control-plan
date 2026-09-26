/**
 * `execution.maxConcurrentProviderStarts`: at most `cap` providers between
 * spawn and their first event at once; the rest wait FIFO. Cold starts are
 * CPU-bound (CLI boot, hooks, MCP connects), so on a small host concurrent
 * starts slow every one of them down. `Infinity` (the default) never waits.
 */
export class StartSlots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly cap: number = Infinity) {}

  get limited(): boolean {
    return Number.isFinite(this.cap);
  }

  /**
   * Resolves with an idempotent release once a slot is free, or with `null` if
   * `abort` settles first (the waiter is dropped and holds nothing).
   */
  async acquire(abort?: Promise<unknown>): Promise<(() => void) | null> {
    if (this.active < this.cap) return this.take();
    let wake!: () => void;
    const turn = new Promise<void>((resolve) => (wake = resolve));
    this.waiters.push(wake);
    const won = await Promise.race([turn.then(() => true), (abort ?? new Promise<never>(() => {})).then(() => false)]);
    if (won) return this.take();
    const i = this.waiters.indexOf(wake);
    if (i >= 0) this.waiters.splice(i, 1);
    else this.handOff(); // woken in the same tick we aborted: pass the slot on
    return null;
  }

  private take(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.handOff();
    };
  }

  private handOff(): void {
    if (this.active < this.cap) this.waiters.shift()?.();
  }
}
