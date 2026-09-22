// S43 — SerialQueue: nunca dos tasks en vuelo; un fallo no rompe la cola.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SerialQueue } from "../src/queue.ts";

describe("S43 SerialQueue", () => {
  it("tasks concurrentes corren en serie — nunca 2 en vuelo", async () => {
    const q = new SerialQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 8 }, (_, i) =>
      q.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
        inFlight--;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("una task que falla no rompe la cola ni contagia al siguiente", async () => {
    const q = new SerialQueue();
    const first = q.run(async () => {
      throw new Error("boom");
    });
    await assert.rejects(first, /boom/);
    const second = await q.run(async () => "ok");
    assert.equal(second, "ok");
  });
});
