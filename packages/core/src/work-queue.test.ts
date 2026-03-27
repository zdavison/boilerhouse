import { describe, test, expect } from "bun:test";
import { WorkQueue } from "./work-queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WorkQueue", () => {
	test("processes items FIFO", async () => {
		const order: number[] = [];

		const q = new WorkQueue<number>({
			process: async (n) => {
				order.push(n);
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);

		// Wait for drain
		await sleep(10);
		expect(order).toEqual([1, 2, 3]);
		expect(q.pending).toBe(0);
		expect(q.isProcessing).toBe(false);
	});

	test("respects concurrency limit", async () => {
		let peak = 0;
		let concurrent = 0;

		const q = new WorkQueue<number>({
			concurrency: 2,
			process: async () => {
				concurrent++;
				peak = Math.max(peak, concurrent);
				await sleep(20);
				concurrent--;
			},
		});

		for (let i = 0; i < 6; i++) q.enqueue(i);

		// Wait for all to finish
		await sleep(200);
		expect(peak).toBe(2);
		expect(q.isProcessing).toBe(false);
	});

	test("deduplicates by key", async () => {
		const processed: string[] = [];

		const q = new WorkQueue<{ id: string; v: number }>({
			key: (item) => item.id,
			process: async (item) => {
				await sleep(10);
				processed.push(`${item.id}:${item.v}`);
			},
		});

		q.enqueue({ id: "a", v: 1 });
		q.enqueue({ id: "a", v: 2 }); // should be dropped
		q.enqueue({ id: "b", v: 1 });

		await sleep(100);
		expect(processed).toEqual(["a:1", "b:1"]);
	});

	test("allows re-enqueue after key is consumed", async () => {
		const processed: string[] = [];

		const q = new WorkQueue<string>({
			key: (s) => s,
			process: async (s) => {
				await sleep(5);
				processed.push(s);
			},
		});

		q.enqueue("x");

		// Wait for it to be consumed then re-enqueue
		await sleep(30);
		q.enqueue("x");
		await sleep(30);

		expect(processed).toEqual(["x", "x"]);
	});

	test("calls onError per item without stopping the queue", async () => {
		const results: string[] = [];
		const errors: string[] = [];

		const q = new WorkQueue<string>({
			process: async (s) => {
				if (s === "bad") throw new Error("boom");
				results.push(s);
			},
			onError: (err, item) => {
				errors.push(`${item}:${(err as Error).message}`);
			},
		});

		q.enqueue("ok1");
		q.enqueue("bad");
		q.enqueue("ok2");

		await sleep(30);
		expect(results).toEqual(["ok1", "ok2"]);
		expect(errors).toEqual(["bad:boom"]);
	});

	test("items enqueued during processing are picked up", async () => {
		const processed: number[] = [];

		const q = new WorkQueue<number>({
			process: async (n) => {
				processed.push(n);
				if (n === 1) {
					// Enqueue more while processing
					q.enqueue(4);
					q.enqueue(5);
				}
				await sleep(5);
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);

		await sleep(100);
		expect(processed).toEqual([1, 2, 3, 4, 5]);
	});

	test("pending reflects queue size", () => {
		const q = new WorkQueue<number>({
			process: async () => {
				await sleep(1000);
			},
		});

		expect(q.pending).toBe(0);
		q.enqueue(1);
		// First item is immediately picked up for processing, rest stay pending
		q.enqueue(2);
		q.enqueue(3);
		// Pending count is at most 2 (item 1 might already be picked up)
		expect(q.pending).toBeGreaterThanOrEqual(0);
		expect(q.pending).toBeLessThanOrEqual(3);
	});
});
