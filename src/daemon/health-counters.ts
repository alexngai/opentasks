/**
 * Daemon Health Counters (P3 M3 / F10)
 *
 * Tracks failures the daemon would otherwise swallow silently — file-watcher
 * diff errors and provider-reconcile errors — plus liveness timestamps, so an
 * operator can answer "is the watcher / reconcile loop actually healthy?" via
 * the `health` method instead of grepping stderr. Git sync failures are tracked
 * separately by the syncer's SyncerHealth and surfaced alongside these.
 */

export interface DaemonHealthSnapshot {
  /** Count of file-watcher diff errors swallowed since start. */
  watcherErrors: number;
  /** ISO timestamp of the most recent watcher error, or null. */
  lastWatcherErrorAt: string | null;
  /** Count of provider-reconcile runs that completed cleanly. */
  reconcileRuns: number;
  /** Count of provider-reconcile runs that threw. */
  reconcileErrors: number;
  /** ISO timestamp of the last completed reconcile (success or failure). */
  lastReconcileAt: string | null;
  /** ISO timestamp of the most recent reconcile error, or null. */
  lastReconcileErrorAt: string | null;
}

export interface HealthCounters {
  /** A file-watcher diff threw and was swallowed. */
  recordWatcherError(): void;
  /** A provider reconcile completed cleanly. */
  recordReconcileRun(): void;
  /** A provider reconcile threw. */
  recordReconcileError(): void;
  /** Immutable snapshot for the `health` response. */
  snapshot(): DaemonHealthSnapshot;
}

/**
 * Create a daemon health-counters tracker.
 */
export function createHealthCounters(): HealthCounters {
  const s: DaemonHealthSnapshot = {
    watcherErrors: 0,
    lastWatcherErrorAt: null,
    reconcileRuns: 0,
    reconcileErrors: 0,
    lastReconcileAt: null,
    lastReconcileErrorAt: null,
  };

  return {
    recordWatcherError(): void {
      s.watcherErrors += 1;
      s.lastWatcherErrorAt = new Date().toISOString();
    },
    recordReconcileRun(): void {
      s.reconcileRuns += 1;
      s.lastReconcileAt = new Date().toISOString();
    },
    recordReconcileError(): void {
      s.reconcileErrors += 1;
      const now = new Date().toISOString();
      s.lastReconcileAt = now;
      s.lastReconcileErrorAt = now;
    },
    snapshot(): DaemonHealthSnapshot {
      return { ...s };
    },
  };
}
