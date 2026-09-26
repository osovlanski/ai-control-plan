import { describe, expect, it } from "vitest";
import { StartSlots } from "../../src/modules/harness/start-slots.js";

describe("StartSlots", () => {
  it("admits up to the cap, then FIFO; release is idempotent; abort drops a waiter", async () => {
    const slots = new StartSlots(1);
    const first = (await slots.acquire())!;
    const order: string[] = [];
    let abort!: () => void;
    const aborted = slots.acquire(new Promise<void>((r) => (abort = r)));
    const second = slots.acquire().then((rel) => (order.push("second"), rel!));
    abort();
    expect(await aborted).toBeNull();
    first();
    first(); // idempotent: must not free a second slot
    const rel2 = await second;
    expect(order).toEqual(["second"]);
    let thirdIn = false;
    const third = slots.acquire().then((rel) => ((thirdIn = true), rel!));
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdIn).toBe(false);
    rel2();
    (await third)();
  });

  it("unlimited never waits", async () => {
    const slots = new StartSlots();
    expect(slots.limited).toBe(false);
    await Promise.all(Array.from({ length: 50 }, () => slots.acquire()));
  });
});
