import type { BigIntStats, Stats } from "node:fs";

export interface AssertOwnerOnlyOptions {
  kind?: "file" | "directory";
  maxBytes?: number;
  message?: string;
}

export function assertOwnerOnly(
  stat: Stats | BigIntStats,
  options?: AssertOwnerOnlyOptions,
): void;
export function privateDirectory(directory: string): void;
export function writePrivate(file: string, data: string): void;
