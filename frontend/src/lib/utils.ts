import type { TransferState } from "../types";

/**
 * Format a raw byte count into a human-readable string.
 *
 * Uses 1024-based units (KiB/MiB/GiB) with one decimal place.
 * The log1024 approach avoids a chain of if/else and automatically
 * handles any future unit (TB, PB) without code changes.
 *
 * Examples:
 *   0       → "0 B"
 *   1536    → "1.5 KB"
 *   1048576 → "1.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Map an internal TransferState enum value to a user-facing label.
 *
 * Centralising these strings here means the UI components never contain
 * raw state comparisons, and labels can be updated in one place.
 * The nullish coalescing fallback returns the raw state if a new state
 * is added to the enum before this map is updated.
 */
export function formatState(state: TransferState): string {
  const labels: Record<TransferState, string> = {
    pending: "Waiting for acceptance",
    accepted: "Starting…",
    rejected: "Rejected",
    transferring: "Transferring",
    completed: "Completed",
    error: "Error",
  };
  return labels[state] ?? state;
}

/**
 * Format a transfer speed as a human-readable per-second rate.
 *
 * Delegates to formatBytes() for the numeric part so the unit scaling
 * (KB/s, MB/s) is consistent with file size display.
 *
 * @param bytesPerSec  Instantaneous or EMA-smoothed transfer rate.
 */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Format an estimated time remaining for a transfer.
 *
 * Returns "—" when speed is zero (initial state or stalled transfer) to
 * avoid dividing by zero and showing "Infinity s" in the UI.
 *
 * Uses Math.ceil for seconds and minutes so the display never shows "0s"
 * when there is still a non-zero amount remaining — "1s" is more reassuring
 * than "0s" that immediately disappears.
 *
 * @param remainingBytes  Bytes yet to be transferred.
 * @param bytesPerSec     Current transfer rate (should be EMA-smoothed by caller).
 */
export function formatETA(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  const seconds = remainingBytes / bytesPerSec;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${minutes}m ${secs}s`;
}
