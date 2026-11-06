import crypto from "node:crypto";

export const sha256 = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

export const nowIso = (): string => new Date().toISOString();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[…${text.length - max} chars omitted]\n${text.slice(-max)}`;
}

/** Collapse all whitespace so quotes survive re-wrapping and indentation differences. */
export const normalizeWs = (s: string): string => s.replace(/\s+/g, " ").trim();

export function kebab(s: string, max = 80): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

const STOP = new Set(
  "a an the and or of to in on for with without is are be by it this that as at from not no can may when if into its was were".split(" "),
);

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const centsToUsd = (c: number | null | undefined): string =>
  c === null || c === undefined ? "n/a" : `$${(c / 100).toFixed(2)}`;

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
