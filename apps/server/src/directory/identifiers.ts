import { hex, sha256, sha256Hex } from "@/server/auth/crypto";

/** Deterministic opaque IDs make cross-store initialization and registration retryable. */
export async function stableId(
  namespace: string,
  ...parts: string[]
): Promise<string> {
  const digest = await sha256(JSON.stringify([namespace, ...parts]));
  // UUID version 8: application-defined digest with standard variant bits.
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const id = hex(digest.slice(0, 16));
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Registration receipts fingerprint the serialized payload, whatever its shape. */
export function payloadHash(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}

/** Both directed rules and normal DM creation use this single pair owner. */
export function directConversationId(first: string, second: string) {
  return stableId("direct-conversation", ...[first, second].sort());
}
