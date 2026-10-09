import {
  CROSS_SEARCH_CURSOR_MAX_LENGTH,
  SearchPositionSchema,
  type SearchPosition,
} from "@vaskel/contracts/search";
import { base64url } from "@/server/auth/crypto";

/** A creation position is a pagination input, never authority or a snapshot promise. */
export function encodeSearchCursor(position: SearchPosition): string {
  return base64url(new TextEncoder().encode(JSON.stringify(position)));
}

export function decodeSearchCursor(token: string): SearchPosition | null {
  if (
    token.length > CROSS_SEARCH_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  )
    return null;
  try {
    const bytes = Uint8Array.from(
      atob(token.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const parsed = SearchPositionSchema.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
