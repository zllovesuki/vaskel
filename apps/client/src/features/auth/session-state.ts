import { api } from "@/client/api/contract";
import { createContext, useContext } from "react";
import { type IdentityProfile } from "@vaskel/contracts/identity";

export const UserContext = createContext<IdentityProfile | null>(null);
export const useOptionalUser = () => useContext(UserContext);
export function useUser() {
  const user = useOptionalUser();
  if (!user) throw new Error("An authenticated account is required.");
  return user;
}
export function readSession(signal: AbortSignal) {
  // Root access owns this request, so offline Query pausing cannot trap entry.
  return api.me(undefined, { signal: signal });
}
export async function signOut(accountId: string) {
  await api.signOut(undefined, { context: { accountId } });
}
