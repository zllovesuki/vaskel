import { apiFailure } from "@/client/api/errors";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BlockStatus, SetBlock } from "@vaskel/contracts/blocking";
import { errorMessage } from "@/client/api/client";
import { blockKey } from "@/client/api/blocks";
import { useUser } from "@/client/features/auth/session-state";
import { commitBlock } from "@/client/features/blocking/commit-block";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";

/**
 * One person's block setting: an uncertain attempt is retried as the same
 * command, and only an owner-confirmed status replaces the one it was given.
 * `settled` hears whether a command committed, even after its row has gone.
 */
export function useBlockSetting(
  status: BlockStatus,
  name: string,
  settled?: (committed: boolean) => void,
) {
  const { t, text } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const client = useQueryClient();
  const [attempt, setAttempt] = useState<SetBlock | null>(null);
  const [committed, setCommitted] = useState<BlockStatus | null>(null);
  const current =
    committed && committed.revision > status.revision ? committed : status;
  const lifecycle = useRef<{ active: boolean; abort: AbortController } | null>(
    null,
  );
  useEffect(() => {
    const generation = { active: true, abort: new AbortController() };
    lifecycle.current = generation;
    return () => {
      generation.active = false;
      generation.abort.abort();
    };
  }, []);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const generation = lifecycle.current;
      if (!generation?.active) return;
      const command = attempt ?? {
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        blocked: !current.blocked,
        expectedRevision: current.revision,
      };
      setAttempt(command);
      try {
        const result = await commitBlock(
          client,
          user.userId,
          status.targetId,
          command,
          generation.abort.signal,
        );
        if (!generation.active) return;
        setAttempt(null);
        setCommitted(result);
      } catch (error) {
        if (!generation.active) return;
        if (
          apiFailure(error) &&
          [
            "stale_revision",
            "command_expired",
            "command_conflict",
            "invalid_input",
            "capacity",
            "not_found",
            "forbidden",
            "unauthenticated",
          ].includes(apiFailure(error)?.code ?? "")
        ) {
          setAttempt(null);
          await client.invalidateQueries({ queryKey: blockKey(user.userId) });
        }
        throw error;
      }
    },
    onSuccess: () => settled?.(true),
    onError: () => settled?.(false),
  });
  return {
    blocked: current.blocked,
    /** A retry resends the command already chosen, so it asks nothing again. */
    retrying: attempt !== null,
    pending: mutation.isPending,
    disabled: !canUseNetwork || mutation.isPending,
    commit: () => mutation.mutate(),
    label: mutation.isPending
      ? t("blocking.saving")
      : mutation.error && attempt
        ? t("blocking.retrySetting")
        : current.blocked
          ? t("blocking.unblock")
          : t("blocking.block"),
    accessibleName: attempt
      ? t("blocking.retryNamed", { name })
      : current.blocked
        ? t("blocking.unblockNamed", { name })
        : t("blocking.blockNamed", { name }),
    error: mutation.error
      ? attempt
        ? t("blocking.retryConfirm", {
            error: text(errorMessage(mutation.error)),
          })
        : text(errorMessage(mutation.error))
      : null,
  };
}
