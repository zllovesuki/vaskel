import { validateORPCError } from "@orpc/contract";
import { apiErrors } from "@vaskel/contracts/api";
import type { z } from "zod";
import { type OwnerScope } from "@vaskel/contracts/messaging";
import { createORPCErrorFromJson, isORPCErrorJson } from "@orpc/client";

import { bookmarkRequest } from "@/client/api/bookmark";

import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";

import {
  ApiError,
  NetworkError,
  isCancellation,
  apiFailure,
  responseFailure,
  responseRequestId,
} from "./errors";
export { responseRequestId } from "./errors";
export {
  ApiError,
  apiFailure,
  NetworkError,
  isCancellation,
  isNetworkError,
  errorMessage,
  failureMessage,
} from "./errors";

type ApiAuthority = import("@vaskel/contracts/api").ApiAuthority;
export type RequestScope = (
  | { authority: "resource" | "message"; owner: OwnerScope }
  | {
      authority: Exclude<ApiAuthority, "resource" | "message">;
      owner?: OwnerScope;
    }
) & {
  freshness?: "account" | "search";
};

export interface RequestLifetime {
  current: () => boolean;
  accountId: string | null;
}

export interface RequestAccess {
  begin(path: string, init: RequestInit, scope: RequestScope): RequestLifetime;
  succeeded?(
    path: string,
    startedAt: number,
    lifetime: RequestLifetime,
    scope: RequestScope,
  ): void;
  failed(path: string, error: ApiError, scope: RequestScope): void;
}
let access: RequestAccess | null = null;
export function installRequestAccess(next: RequestAccess) {
  access = next;
  return () => {
    if (access === next) access = null;
  };
}
export async function requestWithInit<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit,
  scope: RequestScope,
): Promise<T> {
  const { response, checkCurrent, failed, succeeded } = await privateResponse(
    path,
    init,
    scope,
  );
  return decodeResponse(schema, response, checkCurrent, failed, succeeded);
}

/** Streaming bodies keep the same account, cancellation and denial handling. */
export async function requestStream<T>(
  path: string,
  init: RequestInit,
  consume: (response: Response, checkCurrent: () => void) => Promise<T>,
  scope: RequestScope,
): Promise<T> {
  const { response, checkCurrent, failed, succeeded } = await privateResponse(
    path,
    init,
    scope,
  );
  if (!response.ok) {
    const failure = await readFailure(response, checkCurrent);
    failed(apiFailure(failure)!);
    throw failure;
  }
  try {
    const result = await consume(response, checkCurrent);
    checkCurrent();
    succeeded();
    return result;
  } catch (error) {
    checkCurrent();
    if (isCancellation(error)) throw error;
    const failure =
      error instanceof ApiError
        ? error
        : new NetworkError(responseRequestId(response));
    failed(failure);
    throw failure;
  }
}

export async function privateResponse(
  path: string,
  init: RequestInit,
  scope: RequestScope,
  request?: Request,
) {
  const startedAt = Date.now();
  const policy = access;
  const lifetime = policy?.begin(path, init, scope);
  const checkCurrent = () => {
    if ((lifetime && !lifetime.current()) || init.signal?.aborted)
      throw new DOMException("The request was canceled.", "AbortError");
  };
  const bookmark = bookmarkRequest();
  const headers = new Headers(init.headers);
  if (lifetime?.accountId && !headers.has(EXPECTED_ACCOUNT_HEADER))
    headers.set(EXPECTED_ACCOUNT_HEADER, lifetime.accountId);
  if (bookmark.header) headers.set("X-Vaskel-D1-Bookmark", bookmark.header);
  let response: Response;
  try {
    response = await fetch(request ?? path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch (error) {
    checkCurrent();
    if (isCancellation(error)) throw error;
    const failure = new NetworkError();
    policy?.failed(path, failure, scope);
    throw failure;
  }
  checkCurrent();
  bookmark.accept(response);
  return {
    response,
    checkCurrent,
    failed: (error: ApiError) => policy?.failed(path, error, scope),
    succeeded: () => {
      checkCurrent();
      if (
        lifetime?.accountId &&
        headers.get(EXPECTED_ACCOUNT_HEADER) === lifetime.accountId
      )
        policy?.succeeded?.(path, startedAt, lifetime, scope);
    },
  };
}

async function readFailure(
  response: Response,
  checkCurrent: () => void,
  readJson: () => Promise<unknown> = () => response.json(),
) {
  let json: unknown;
  try {
    json = await readJson();
  } catch {
    /* HTTP denial facts survive an unreadable body. */
  }
  checkCurrent();
  let error: unknown;
  if (isORPCErrorJson(json)) {
    try {
      error = await validateORPCError(apiErrors, createORPCErrorFromJson(json));
    } catch {
      /* A malformed native failure retains only the HTTP facts. */
    }
  }
  checkCurrent();
  return apiFailure(responseFailure(response, error))!;
}

/** Only raw byte endpoints use this JSON acknowledgement decoder. */
async function decodeResponse<T>(
  schema: z.ZodType<T>,
  response: Response,
  checkCurrent: () => void,
  failed: (error: ApiError) => void,
  succeeded: () => void,
): Promise<T> {
  if (!response.ok) {
    const failure = await readFailure(response, checkCurrent);
    failed(apiFailure(failure)!);
    throw failure;
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    /* Report a malformed acknowledgement below. */
  }
  checkCurrent();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const failure = responseFailure(response);
    failed(apiFailure(failure)!);
    throw failure;
  }
  succeeded();
  return parsed.data;
}
export const instance = window.location.origin;
/**
 * Cache identity. Every private query begins with PRIVATE_ROOT, this instance
 * and the account, so account retirement removes one prefix; an owner-level
 * key is a prefix of its channel-level keys, so one invalidation reaches every
 * narrower query. Modules with their own reads extend `privateKey` beside
 * their query options.
 */
export const PRIVATE_ROOT = ["private"] as const;
export const privateKey = (userId: string) =>
  [...PRIVATE_ROOT, instance, userId] as const;
export const directoryKey = (userId: string) =>
  [...privateKey(userId), "directory"] as const;
export const resourceDirectoryKey = (userId: string, owner: OwnerScope) =>
  [...directoryKey(userId), owner.kind, owner.id] as const;
export const membersRootKey = (userId: string) =>
  [...privateKey(userId), "members"] as const;
export const membersKey = (userId: string, owner: OwnerScope) =>
  [...membersRootKey(userId), owner.kind, owner.id] as const;
export const invitesKey = (userId: string, serverId: string) =>
  [...privateKey(userId), "invites", serverId] as const;
export const mediaRoomsKey = (userId: string) =>
  [...privateKey(userId), "media-room"] as const;
export const mediaRoomKey = (
  userId: string,
  owner: OwnerScope,
  channelId: string,
) => [...mediaRoomsKey(userId), owner.kind, owner.id, channelId] as const;
/** One owner's timelines; `timelineKey` narrows to one channel's window. */
export const ownerTimelineKey = (userId: string, owner: OwnerScope) =>
  [...privateKey(userId), "timeline", owner.kind, owner.id] as const;
export const timelineKey = (
  userId: string,
  owner: OwnerScope,
  channelId: string,
) => [...ownerTimelineKey(userId, owner), channelId] as const;
/** One owner's message search; a channel and then a phrase narrow it. */
export const ownerSearchKey = (userId: string, owner: OwnerScope) =>
  [...privateKey(userId), "search", owner.kind, owner.id] as const;
export const messageSearchKey = (
  userId: string,
  owner: OwnerScope,
  channelId: string,
  phrase?: string,
) =>
  [
    ...ownerSearchKey(userId, owner),
    channelId,
    ...(phrase === undefined ? [] : [phrase]),
  ] as const;
