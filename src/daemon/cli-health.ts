import { CliError } from "../locale.js";
import { DAEMON_HOST } from "./constants.js";

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHealth({
  fetchImpl,
  port,
  timeoutMs,
}: {
  fetchImpl: typeof fetch;
  port: number;
  timeoutMs: number;
}): Promise<void> {
  const url = `http://${DAEMON_HOST}:${port}/health`;
  const startedAt = Date.now();
  // Simple polling; avoids bringing in extra deps.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (res.ok) return;
    } catch {
      // Retry until the deadline.
    }
    await sleep(200);
  }
  throw new CliError("service.healthUnreachable", { address: url });
}

export async function waitForHealthWithRetries({
  fetchImpl,
  port,
  attempts,
  timeoutMs,
  delayMs,
}: {
  fetchImpl: typeof fetch;
  port: number;
  attempts: number;
  timeoutMs: number;
  delayMs: number;
}): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await waitForHealth({ fetchImpl, port, timeoutMs });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(Math.round(delayMs * 1.6 ** attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new CliError("service.healthUnreachable", { address: `${DAEMON_HOST}:${port}` });
}

export async function checkAuth({
  fetchImpl,
  token,
  port,
}: {
  fetchImpl: typeof fetch;
  token: string;
  port: number;
}): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://${DAEMON_HOST}:${port}/v1/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkAuthWithRetries({
  fetchImpl,
  token,
  port,
  attempts,
  delayMs,
}: {
  fetchImpl: typeof fetch;
  token: string;
  port: number;
  attempts: number;
  delayMs: number;
}): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkAuth({ fetchImpl, token, port })) return true;
    if (attempt < attempts - 1) {
      await sleep(Math.round(delayMs * 1.4 ** attempt));
    }
  }
  return false;
}
