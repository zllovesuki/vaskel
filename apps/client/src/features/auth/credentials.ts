import { api } from "@/client/api/contract";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useAccess } from "@/client/features/cache/access/context";

export interface Credentials {
  email: string;
  password: string;
}

/** The workflow owns its mutation; successful credentials still require fresh account admission. */
export function useSignInRequest() {
  const { retry } = useAccess();
  return async ({ email, password }: Credentials) => {
    await api.signIn({ body: { email, password } });

    await retry();
  };
}

export function useVerificationResend() {
  return useMutation({
    mutationFn: async (email: string) => {
      await api.resendVerification({ body: { email } });
    },
  });
}

export function useBootstrapStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["bootstrap-status"],
    queryFn: ({ signal }) => api.bootstrapStatus(undefined, { signal: signal }),
    enabled,
    retry: false,
  });
}
