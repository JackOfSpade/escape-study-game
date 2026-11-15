import type { IncomingMessage, ServerResponse } from "node:http";
export const REPORT_LIMITS: {
  retention: number;
  maxAgeMs: number;
  description: number;
  client: number;
  logTail: number;
  logLines: number;
  usageRows: number;
};
export function collapseRepeats(lines: string[]): string[];
export function createBugReports(options: {
  directory: string;
  logs?: { title: string; path: string }[];
  usageLog?: string;
  status?: () => Promise<string> | string;
  now?: () => number;
  limits?: Partial<typeof REPORT_LIMITS>;
}): {
  directory: string;
  route(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};
