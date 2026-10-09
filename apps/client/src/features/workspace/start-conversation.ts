import { api } from "@/client/api/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { directoryKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { resourceLocation } from "@/client/routes/resource-location";

/** Opens (or creates) the direct conversation with a person and navigates to it. */
export function useStartConversation(onStarted?: () => void) {
  const user = useUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await api.createConversation({ body: { userId } });
      await client.invalidateQueries({
        queryKey: directoryKey(user.userId),
      });
      await navigate({
        ...resourceLocation(result.owner, result.channelId),
        search: {},
      });
      onStarted?.();
    },
  });
}
