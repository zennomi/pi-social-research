import { setTimeout as delay } from "node:timers/promises";

/** A single deadline covers attempts, retry waits and response body reads. */
export function requestDeadline(signal?: AbortSignal, timeoutMs = 30_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { timeout, combined: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

export async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Node's timer wraps the abort reason; callers expect the original reason.
    throw signal.reason;
  }
}

export function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  return header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
}
