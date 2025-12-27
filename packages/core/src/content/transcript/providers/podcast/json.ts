export type JsonRecord = Record<string, unknown>

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getJsonPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isJsonRecord(current)) return undefined
    current = current[key]
  }
  return current
}

export function getJsonString(value: unknown, path: readonly string[]): string | null {
  const found = getJsonPath(value, path)
  return typeof found === 'string' ? found : null
}

export function getJsonNumber(value: unknown, path: readonly string[]): number | null {
  const found = getJsonPath(value, path)
  return typeof found === 'number' && Number.isFinite(found) ? found : null
}

export function getJsonArray(value: unknown, path: readonly string[]): unknown[] {
  const found = getJsonPath(value, path)
  return Array.isArray(found) ? found : []
}

export function asRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is JsonRecord => isJsonRecord(v))
}

export function getRecordString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}
