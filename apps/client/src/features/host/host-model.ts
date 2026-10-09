import {
  INSTANCE_ICON_BYTE_LIMIT,
  OPERATOR_PAGE_LIMIT,
} from "@vaskel/contracts/instance";

export const ICON_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const ICON_ACCEPT = ICON_CONTENT_TYPES.join(",");

/** The host's own bytes are checked here, so a rejected icon costs no request. */
export function iconFileProblem(file: {
  type: string;
  size: number;
}): "type" | "size" | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(ICON_CONTENT_TYPES as readonly string[]).includes(type)) return "type";
  // An empty selection carries no signature for the instance actor to admit.
  if (!(file.size > 0)) return "type";
  return file.size > INSTANCE_ICON_BYTE_LIMIT ? "size" : null;
}

/**
 * A created date crosses the contract as a bare string, so a value the platform
 * cannot parse must not reach `Intl`, whose `RangeError` would unmount the page.
 */
export const isInstant = (value: string): boolean =>
  Number.isFinite(Date.parse(value));
export const UNKNOWN_DATE = "—";

/** A bar reads as a share of its budget: never negative, never past full. */
export function usageShare(usedBytes: number, budgetBytes: number): number {
  if (!Number.isFinite(usedBytes) || !(budgetBytes > 0)) return 0;
  return Math.min(1, Math.max(0, usedBytes / budgetBytes));
}

export const usagePercent = (usedBytes: number, budgetBytes: number): number =>
  Math.round(usageShare(usedBytes, budgetBytes) * 100);

/**
 * `partial` also marks a further page, so only a short page means the instance
 * could not read every owner it listed.
 */
export function usageIncomplete(page: {
  owners: readonly unknown[];
  nextAfter: string | null;
  partial: boolean;
}): boolean {
  return (
    page.partial &&
    (page.nextAfter === null || page.owners.length < OPERATOR_PAGE_LIMIT)
  );
}
