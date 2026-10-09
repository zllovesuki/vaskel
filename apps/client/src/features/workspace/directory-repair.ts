/** Directory discovery must advance even when the selected owner was found long ago. */
export class DirectoryRepair {
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastCycle = Date.now();
  private interval: number;
  constructor(
    private readonly dependencies: {
      interval: number;
      visible(): boolean;
      refresh(): Promise<{ hasNextPage: boolean }>;
      next(): Promise<unknown>;
    },
  ) {
    this.interval = dependencies.interval;
    this.schedule();
  }
  setInterval(interval: number) {
    this.interval = interval;
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed) return;
    // Hints, Query updates and optional socket flaps cannot reset discovery.
    this.timer = setTimeout(
      () => {
        this.lastCycle = Date.now();
        void this.refresh();
        this.schedule();
      },
      Math.max(0, this.lastCycle + this.interval - Date.now()),
    );
  }
  refresh = async () => {
    if (this.disposed || this.running || !this.dependencies.visible()) return;
    this.running = true;
    try {
      const result = await this.dependencies.refresh();
      if (!this.disposed && this.dependencies.visible() && result.hasNextPage)
        await this.dependencies.next();
    } catch {
      // Query retains its failure presentation. The next independent cycle repairs.
    } finally {
      this.running = false;
    }
  };
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
