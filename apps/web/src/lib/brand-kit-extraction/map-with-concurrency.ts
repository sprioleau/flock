export async function mapWithConcurrency<Input, Output>(
  { items, concurrency, mapItem }: {
    items: readonly Input[];
    concurrency: number;
    mapItem: (item: Input, index: number) => Promise<Output>;
  },
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapItem(items[index], index);
      }
    }),
  );

  return results;
}
