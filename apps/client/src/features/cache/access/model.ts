import type { IdentityProfile } from "@vaskel/contracts/identity";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { UiMessage } from "@/client/features/i18n/messages";
import type {
  AccountFence,
  CachedAccount,
  HistoryCache,
} from "@/client/features/cache/model";

export type AccessMode =
  | "checking"
  | "online"
  | "live-disconnected"
  | "cached"
  | "reconnecting"
  | "signed-out";

export interface AccessState {
  mode: AccessMode;
  canUseNetwork: boolean;
  user: IdentityProfile | null;
  cachedAccount: CachedAccount | null;
  accountFence: AccountFence | null;
  cacheAvailable: boolean;
  attempt: number;
  crossSearchEpoch: number;
  deniedOwners: readonly string[];
  invalidatedOwners: readonly string[];
  error: UiMessage | null;
}

type IdentityResult =
  { status: "authenticated"; user: IdentityProfile } | { status: string };

export interface AccessDependencies {
  cache: HistoryCache;
  identity(signal: AbortSignal): Promise<IdentityResult>;
  stopPrivateWork(): void;
  closeAccount(): void;
  invalidateCrossSearch(accountId: string, owner?: OwnerScope): void;
  invalidateOwner(
    owner: OwnerScope,
    accountId: string | null,
    discard: boolean,
  ): void;
}
