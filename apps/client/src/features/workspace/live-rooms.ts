import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { Occupancy } from "@vaskel/contracts/occupancy";
import type { OwnerScope } from "@vaskel/contracts/messaging";

export interface LiveRoom {
  owner: OwnerScope;
  channelId: string;
  roomName: string;
  circleName: string | null;
  canModerate: boolean;
  occupancy: Occupancy;
}

/** Voice rooms with someone in them, across every circle and conversation the viewer belongs to. */
export function liveRooms(resources: ResourceSummary[]): LiveRoom[] {
  return resources.flatMap((resource) =>
    resource.channels
      .filter(
        (channel) =>
          channel.kind === "media" &&
          channel.occupancy !== null &&
          channel.occupancy.participantIds.length > 0,
      )
      .map((channel) => ({
        owner: resource.owner,
        channelId: channel.id,
        roomName: channel.name,
        circleName: resource.owner.kind === "server" ? resource.name : null,
        canModerate:
          resource.owner.kind === "server" && resource.role === "owner",
        occupancy: channel.occupancy!,
      })),
  );
}

/** Elapsed call time as m:ss or h:mm:ss. */
export function elapsedSince(startedAt: number | null, now: number): string {
  if (startedAt === null) return "";
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
