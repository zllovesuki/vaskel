import { createD1Database } from "@/server/storage/d1-database";
import type { IdentityDatabase } from "@/server/storage/identity-schema";

export type DirectoryDatabase = Pick<
  IdentityDatabase,
  | "block_candidates"
  | "resource_directory"
  | "resource_membership_index"
  | "instance_capability"
  | "directory_audit"
  | "identity_user"
>;

export function directoryDatabase(
  env: Pick<Env, "IDENTITY_DB">,
  session?: D1DatabaseSession,
) {
  // Omitting a session preserves primary-only semantics for authoritative
  // capability checks and mutations. Replica-eligible reads pass one explicitly.
  return createD1Database<DirectoryDatabase>(session ?? env.IDENTITY_DB);
}

/** Consistency metadata only: a bookmark never grants account/resource access. */
export function validateD1Bookmark(
  value: string | null | undefined,
): string | undefined {
  if (
    !value ||
    value.length > 256 ||
    !/^[\x20-\x7E]+$/.test(value) ||
    value.trim().length === 0
  ) {
    return undefined;
  }
  return value;
}

export function createDirectorySession(
  env: Pick<Env, "IDENTITY_DB">,
  bookmark?: string,
  primary = false,
) {
  // Fresh identity/write authority must select primary before considering
  // client metadata. A bookmark is only a consistency floor for eligible reads.
  const anchor = primary
    ? "first-primary"
    : (validateD1Bookmark(bookmark) ?? "first-unconstrained");
  const session = env.IDENTITY_DB.withSession(anchor);
  return { database: directoryDatabase(env, session), session };
}
