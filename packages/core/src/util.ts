/** Trim and hard-cap a string; tolerant of null/undefined. */
export function sanitizeInput(str: unknown, maxLen: number): string {
  return String(str ?? '').trim().slice(0, maxLen);
}

/** Parse JSON, returning null instead of throwing. */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
