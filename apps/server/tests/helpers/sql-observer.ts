import { vi } from "vitest";

/** Observe compiled production statements while delegating to native workerd SQL. */
export async function observeSql<T>(sql: SqlStorage, action: () => Promise<T>) {
  const native = sql.exec.bind(sql);
  const statements: {
    query: string;
    bindings: unknown[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
  }[] = [];
  const observer = vi
    .spyOn(sql, "exec")
    .mockImplementation((query, ...bindings) => {
      const cursor = native(query, ...bindings);
      statements.push({ query, bindings, cursor });
      return cursor;
    });
  try {
    const start = performance.now();
    const value = await action();
    return {
      value,
      durationMs: performance.now() - start,
      statements: statements.map(({ query, bindings, cursor }) => ({
        query,
        bindings,
        rowsRead: cursor.rowsRead,
        rowsWritten: cursor.rowsWritten,
      })),
    };
  } finally {
    observer.mockRestore();
  }
}

export function selectStatements(statements: { query: string }[]) {
  return statements.filter(({ query }) => /^\s*select\b/i.test(query));
}
