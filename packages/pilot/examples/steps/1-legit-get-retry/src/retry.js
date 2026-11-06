// Retry helper with exponential backoff for transient Orders API failures.
export function isTransient(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || (err?.status >= 500 && err?.status < 600) || err?.cause?.code === "ECONNRESET";
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 100, shouldRetry = isTransient } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err)) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}
