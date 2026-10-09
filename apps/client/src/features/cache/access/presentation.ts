import type { IdentityProfile } from "@vaskel/contracts/identity";
import type { CachedAccount } from "@/client/features/cache/model";
import type { UiMessage } from "@/client/features/i18n/messages";
import type { AccessState } from "./model";

export type AccessRecovery =
  { kind: "checking" } | { kind: "unavailable"; error: UiMessage | null };

export type AccessPresentation =
  | {
      kind: "account";
      user: IdentityProfile;
      connection: { kind: "ready" } | AccessRecovery;
    }
  | {
      kind: "cached";
      account: CachedAccount | null;
      connection: AccessRecovery;
    }
  | { kind: "opening" }
  | { kind: "failed"; error: UiMessage }
  | { kind: "signed-out"; notice: UiMessage | null };

export type AccessSnapshot = Pick<
  AccessState,
  | "canUseNetwork"
  | "accountFence"
  | "crossSearchEpoch"
  | "deniedOwners"
  | "invalidatedOwners"
> & { view: AccessPresentation };

/** Presentation follows admission; optional history never establishes identity. */
function present(state: AccessState): AccessPresentation {
  const recovery: AccessRecovery =
    state.mode === "reconnecting" && !state.error
      ? { kind: "checking" }
      : { kind: "unavailable", error: state.error };
  if (state.user)
    return {
      kind: "account",
      user: state.user,
      connection: state.canUseNetwork ? { kind: "ready" } : recovery,
    };
  if (state.mode === "cached" || state.cachedAccount)
    return {
      kind: "cached",
      account: state.cachedAccount,
      connection: recovery,
    };
  if (state.mode === "checking" || state.mode === "reconnecting")
    return state.error
      ? { kind: "failed", error: state.error }
      : { kind: "opening" };
  return { kind: "signed-out", notice: state.error };
}

/** Keep operational capabilities separate from the root's mutually exclusive views. */
export function accessSnapshot(state: AccessState): AccessSnapshot {
  return {
    view: present(state),
    canUseNetwork: state.canUseNetwork,
    accountFence: state.accountFence,
    crossSearchEpoch: state.crossSearchEpoch,
    deniedOwners: state.deniedOwners,
    invalidatedOwners: state.invalidatedOwners,
  };
}
