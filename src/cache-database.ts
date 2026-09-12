type SqliteStatement = {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  run: (...args: unknown[]) => unknown;
};

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
let warningFilterInstalled = false;

const installSqliteWarningFilter = () => {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const message =
      typeof warning === "string"
        ? warning
        : warning && typeof (warning as { message?: unknown }).message === "string"
          ? String((warning as { message?: unknown }).message)
          : "";
    const type =
      typeof args[0] === "string" ? args[0] : (args[0] as { type?: unknown } | undefined)?.type;
    const name = (warning as { name?: unknown } | undefined)?.name;
    const normalizedType = typeof type === "string" ? type : typeof name === "string" ? name : "";
    if (normalizedType === "ExperimentalWarning" && message.toLowerCase().includes("sqlite")) {
      return;
    }
    return original(warning as never, ...(args as [never]));
  }) as typeof process.emitWarning;
};

export async function openSqlite(path: string): Promise<SqliteDatabase> {
  if (isBun) {
    const mod = (await import("bun:sqlite")) as { Database: new (path: string) => SqliteDatabase };
    return new mod.Database(path);
  }
  installSqliteWarningFilter();
  const mod = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  return new mod.DatabaseSync(path);
}
