import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { HostMetricsInfo } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function diskDisplay(disk: NonNullable<HostMetricsInfo["disk"]>) {
  const bytesPerGigabyte = 1_000_000_000;
  const available = disk.availableIncludingPurgeable ?? disk.available;
  const used = disk.availableIncludingPurgeable === undefined ? disk.used : disk.total - available;
  return {
    percent: disk.total > 0 ? (used / disk.total) * 100 : null,
    detail: `可用 ${(available / bytesPerGigabyte).toFixed(1)} / ${(disk.total / bytesPerGigabyte).toFixed(1)} GB`,
  };
}
