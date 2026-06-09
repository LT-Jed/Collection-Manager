import db from "../db.server";

// Total number of phases reported across a full sync (buildFullHierarchy +
// syncSeparateCollections). Kept here so the job row can advertise the count
// up front and the UI can render "Phase X of Y" before the first tick lands.
export const TOTAL_SYNC_PHASES = 6;

// Writes coarse-grained progress for a CollectionSyncJob row. Phase changes are
// flushed immediately; per-item ticks are throttled so a loop over thousands of
// products doesn't hammer the database. All writes are best-effort — a failed
// progress update must never abort the sync itself.
export class SyncProgress {
  private jobId: string;
  private phaseCount: number;
  private phaseNumber = 0;
  private currentTotal = 0;
  private lastProcessed = 0;
  private lastWriteAt = 0;
  private static readonly THROTTLE_MS = 400;

  constructor(jobId: string, phaseCount: number = TOTAL_SYNC_PHASES) {
    this.jobId = jobId;
    this.phaseCount = phaseCount;
  }

  // Advance to the next phase. `total` is the number of items this phase will
  // tick through (0 = indeterminate within the phase).
  async phase(label: string, total = 0): Promise<void> {
    this.phaseNumber += 1;
    this.currentTotal = total;
    this.lastProcessed = 0;
    await this.write(
      {
        phaseLabel: label,
        phaseNumber: this.phaseNumber,
        phaseCount: this.phaseCount,
        processed: 0,
        total,
      },
      true,
    );
  }

  // Report progress within the current phase. Throttled unless `force` is set.
  async tick(processed: number, total?: number): Promise<void> {
    if (total !== undefined) this.currentTotal = total;
    this.lastProcessed = processed;
    const done = total === undefined ? processed >= this.currentTotal : false;
    await this.write(
      { processed, ...(total !== undefined ? { total } : {}) },
      done,
    );
  }

  // Touch the job row so its updatedAt stays fresh during long phases that
  // don't emit per-item ticks (e.g. building the hierarchy). This is what the
  // UI's stall detector keys off — a heartbeat means "the process is alive",
  // so the detector only fires when the background job has genuinely died.
  async heartbeat(): Promise<void> {
    await this.write({ processed: this.lastProcessed }, true);
  }

  private async write(
    data: Record<string, unknown>,
    force: boolean,
  ): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastWriteAt < SyncProgress.THROTTLE_MS) return;
    this.lastWriteAt = now;
    try {
      await db.collectionSyncJob.update({ where: { id: this.jobId }, data });
    } catch {
      // Progress is best-effort; never let a write failure break the sync.
    }
  }
}
