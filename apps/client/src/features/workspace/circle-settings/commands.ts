import { api } from "@/client/api/contract";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { directoryKey, membersKey } from "@/client/api/client";
import { administrationKey } from "@/client/api/administration";

type CircleCommand =
  | { action: "rename"; body: Parameters<typeof api.renameServer>[0]["body"] }
  | {
      action: "settings";
      body: Parameters<typeof api.serverSettings>[0]["body"];
    }
  | { action: "set-role"; body: Parameters<typeof api.setRole>[0]["body"] }
  | {
      action: "transfer";
      body: Parameters<typeof api.transferOwnership>[0]["body"];
    }
  | {
      action: "reorder-channels";
      body: Parameters<typeof api.reorderChannels>[0]["body"];
    }
  | {
      action: "update-channel";
      body: Parameters<typeof api.updateChannel>[0]["body"];
    }
  | {
      action: "channel-member";
      body: Parameters<typeof api.channelMember>[0]["body"];
    }
  | {
      action: "remove-member";
      body: Parameters<typeof api.removeMember>[0]["body"];
    }
  | {
      action: "revoke-invite";
      body: Parameters<typeof api.revokeInvite>[0]["body"];
    };

interface CircleCommands {
  /** Posts one atomic owner command, then waits for refreshed authority. */
  run: (command: CircleCommand) => Promise<void>;
  /** True while any of them is in flight, including that wait. */
  busy: boolean;
}

export const CommandsContext = createContext<CircleCommands | null>(null);

export function useCommands() {
  const commands = useContext(CommandsContext);
  if (!commands) throw new Error("Circle settings own their commands.");
  return commands;
}

export async function postCommand(serverId: string, command: CircleCommand) {
  const params = { id: serverId };
  switch (command.action) {
    case "rename":
      return api.renameServer({ params, body: command.body });
    case "settings":
      return api.serverSettings({ params, body: command.body });
    case "set-role":
      return api.setRole({ params, body: command.body });
    case "transfer":
      return api.transferOwnership({ params, body: command.body });
    case "reorder-channels":
      return api.reorderChannels({ params, body: command.body });
    case "update-channel":
      return api.updateChannel({ params, body: command.body });
    case "channel-member":
      return api.channelMember({ params, body: command.body });
    case "remove-member":
      return api.removeMember({ params, body: command.body });
    case "revoke-invite":
      return api.revokeInvite({ params, body: command.body });
  }
}

/**
 * Every owner command is guarded by a version it also raises, including the
 * room commands, which raise the owner version alongside their own. So the
 * page runs one command at a time and keeps its controls closed until the
 * directory and the members list carry the new version back: the next command
 * reads its expected version from settled data rather than from a stale render.
 */
export function useCircleCommands(
  serverId: string,
  userId: string,
): CircleCommands {
  const client = useQueryClient();
  const [running, setRunning] = useState(0);
  const run = useCallback(
    async (command: CircleCommand) => {
      setRunning((count) => count + 1);
      try {
        await postCommand(serverId, command);
      } finally {
        try {
          await Promise.all([
            client.invalidateQueries({
              queryKey: directoryKey(userId),
            }),
            client.invalidateQueries({
              queryKey: membersKey(userId, { kind: "server", id: serverId }),
            }),
            client.invalidateQueries({
              queryKey: administrationKey(userId, serverId),
            }),
          ]);
        } finally {
          setRunning((count) => count - 1);
        }
      }
    },
    [client, serverId, userId],
  );
  return useMemo(() => ({ run, busy: running > 0 }), [run, running]);
}
