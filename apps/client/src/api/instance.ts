import { type InvitePolicy } from "@vaskel/contracts/instance";
import { rawRoutes } from "@vaskel/contracts/api";
import { api } from "@/client/api/contract";
import { apiQuery } from "./contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { OperatorInstanceSchema } from "@vaskel/contracts/instance";
import { privateKey, requestWithInit } from "@/client/api/client";

/** The icon bytes are public, like the name beside them on the sign-in screen. */
export const INSTANCE_ICON_PATH = rawRoutes.instanceIcon.path;
export type OperatorInstance = z.infer<typeof OperatorInstanceSchema>;

/** The name and icon of this vaskel., readable before anyone signs in. */
export function publicInstanceOptions() {
  return apiQuery.instance.queryOptions({
    queryKey: ["instance"] as const,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export const hostKey = (userId: string) =>
  [...privateKey(userId), "host"] as const;

export function operatorInstanceOptions(userId: string) {
  return queryOptions({
    queryKey: [...hostKey(userId), "instance"],
    queryFn: ({ signal }) =>
      api.operatorInstance(undefined, { signal: signal }),
    retry: false,
  });
}

/** One bounded page of accounts per request; the host pages through by id. */
export function operatorAccountsOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: [...hostKey(userId), "accounts"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.operatorAccounts(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextAfter,
    retry: false,
  });
}

export function operatorUsageOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: [...hostKey(userId), "usage"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.operatorUsage(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextAfter,
    retry: false,
  });
}

export function updateInstance(input: {
  name: string;
  invitePolicy: InvitePolicy;
}) {
  return api.updateInstance({ body: input });
}

/** The icon is one raster body whose declared type must match its own bytes. */
export function uploadInstanceIcon(file: File) {
  return requestWithInit(
    rawRoutes.uploadIcon.path,
    rawRoutes.uploadIcon.output,
    { method: "POST", headers: { "Content-Type": file.type }, body: file },
    rawRoutes.uploadIcon,
  );
}
