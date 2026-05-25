import type { TransferState } from "../types";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

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

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatETA(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  const seconds = remainingBytes / bytesPerSec;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  // Math.ceil avoids showing "0s" when there is still time remaining
  return `${minutes}m ${secs}s`;
}
