// Better Auth 1.7.5 unconditionally imports these types in its database union.
// vaskel selects its native D1 adapter; neither backend is available to this
// Worker. Keep their unused union branches nominal and unconstructible rather
// than making an empty interface accept arbitrary invalid database objects.
// This file contributes declarations only, with no runtime import or shim.
// Remove a declaration if the dependency stops importing that backend type.
declare module "bun:sqlite" {
  export class Database {
    private readonly unsupportedBunSqliteBackend: never;
    private constructor();
  }
}

declare module "node:sqlite" {
  export class DatabaseSync {
    private readonly unsupportedNodeSqliteBackend: never;
    private constructor();
  }
}
