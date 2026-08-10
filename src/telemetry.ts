import { statfsSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";

export type ResourceSnapshot = {
  at: number;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  eventLoopLagMs: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  files: Record<string, number | null>;
};

export async function resourceSnapshot(paths: Record<string, string>): Promise<ResourceSnapshot> {
  const started = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lag = Math.max(0, performance.now() - started);
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const diskPath = Object.values(paths)[0] ?? ".";
  const disk = statfsSync(diskPath);
  return {
    at: Date.now(),
    uptimeSeconds: process.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    eventLoopLagMs: lag,
    diskTotalBytes: Number(disk.blocks) * Number(disk.bsize),
    diskFreeBytes: Number(disk.bavail) * Number(disk.bsize),
    files: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fileSize(path)])),
  };
}

function fileSize(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}