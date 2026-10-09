import { type UiLanguage } from "@vaskel/contracts/preferences";
import { api } from "@/client/api/contract";
import { useMutation } from "@tanstack/react-query";
import { ApiError, privateKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";

export function usePreferencesMutation() {
  const user = useUser();
  const { canUseNetwork, preferenceToken, acceptPreferences } = useAccess();
  return useMutation({
    mutationKey: [...privateKey(user.userId), "preferences"],
    retry: false,
    // A click fails immediately when offline; it never becomes a queued save.
    networkMode: "always",
    mutationFn: async (language: UiLanguage) => {
      const token = preferenceToken(user.userId);
      if (!canUseNetwork || !token)
        throw new ApiError("offline", undefined, "blocked");
      const result = await api.preferences({ body: { language } });
      if (!acceptPreferences(token, result.preferences))
        throw new DOMException("The account lifetime changed.", "AbortError");
      return result.preferences;
    },
  });
}
