import type { TransferState } from "../types";

/**
 * Format raw bytes into a human-readable string.
 * e.g. 1536 → "1.5 KB", 1048576 → "1.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Convert internal transfer state enum to readable label.
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
 * Generate a short human-readable transfer speed string.
 * @param bytesPerSec rate in bytes/second
 */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Generate an estimated time remaining string.
 * @param remainingBytes bytes left to transfer
 * @param bytesPerSec current rate
 */
export function formatETA(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  const seconds = remainingBytes / bytesPerSec;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${minutes}m ${secs}s`;
}
