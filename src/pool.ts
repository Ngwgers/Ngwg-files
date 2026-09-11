// Bounded-concurrency async pool (same semantics as Ngwg-core's Pool; kept
// local so the plugin stays self-contained).

export class Pool {
  constructor(public concurrency = 8) {}

  async run<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from(
      { length: Math.max(1, Math.min(this.concurrency, items.length)) },
      async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await worker(items[i], i);
        }
      },
    );
    await Promise.all(runners);
    return results;
  }
}
