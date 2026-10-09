import { expect, vi } from "vitest";
import { type IdentityProfile } from "@vaskel/contracts/identity";
import type {
  AccountFence,
  CachedAccount,
  HistoryCache,
} from "@/client/features/cache/model";
import type { AccessCoordinator as Coordinator } from "@/client/features/cache/access/coordinator";

let AccessCoordinator: typeof Coordinator;

export let api: typeof import("@/client/api/client");

export const user: IdentityProfile = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "River",
  email: "river@example.test",
  isOperator: false,
  expiresAt: "2030-01-01T00:00:00.000Z",
  preferences: { language: null, revision: 0 },
};

export const fence: AccountFence = {
  origin: "https://vaskel.test",
  cacheId: "00000000-0000-4000-8000-000000000002",
  accountEpoch: "00000000-0000-4000-8000-000000000003",
  accountId: user.userId,
};

export const owner = {
  kind: "server" as const,
  id: "00000000-0000-4000-8000-000000000004",
};

export const selected = {
  owner,
  channelId: "00000000-0000-4000-8000-000000000005",
};

export const remembered: CachedAccount = {
  accountId: user.userId,
  label: user.displayName,
  fence,
  snapshots: [],
};

export function ok<T>(value: T) {
  return { kind: "ok" as const, value };
}

/** What the room socket's access_changed frame becomes for the coordinator. */
export const socketDenial = () =>
  new api.ApiError("forbidden", undefined, "socket");

export function fixture() {
  const cache: HistoryCache = {
    captureAccount: vi.fn(async () => ok(fence)),
    activateAccount: vi.fn(async () => ok(fence)),
    saveDisplayLanguage: vi.fn(async () => ok(undefined)),
    captureScope: vi.fn(async () =>
      ok({
        ...fence,
        owner,
        retirementRevision: 0,
        scopeEpoch: crypto.randomUUID(),
        generation: null,
      }),
    ),
    authorizeScope: vi.fn(async () => ({ kind: "miss" as const })),
    save: vi.fn(async () => ({ kind: "miss" as const })),
    readAccount: vi.fn(async () => ok(remembered)),
    readSnapshot: vi.fn(async () => ({ kind: "miss" as const })),
    recheck: vi.fn(async () => ok(undefined)),
    invalidateAccount: vi.fn(async () => ok(undefined)),
    invalidateOwner: vi.fn(async () => ok(undefined)),
    clear: vi.fn(async () => ok(undefined)),
    clearHistory: vi.fn(async () => ok(undefined)),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(),
  };
  const dependencies = {
    cache,
    identity: vi.fn(async () => ({ status: "authenticated" as const, user })),
    stopPrivateWork: vi.fn(),
    closeAccount: vi.fn(),
    invalidateOwner: vi.fn(),
    invalidateCrossSearch: vi.fn(),
  };
  const access = new AccessCoordinator(dependencies);
  return { access, cache, dependencies };
}

export async function authenticated(access: Coordinator) {
  access.start(true);
  await vi.waitFor(() => expect(access.getSnapshot().mode).toBe("online"));
  expect(access.getSnapshot().canUseNetwork).toBe(true);
}
export async function loadAccessModules() {
  api = await import("@/client/api/client");
  ({ AccessCoordinator } =
    await import("@/client/features/cache/access/coordinator"));
}
