import { usePresence } from "@/client/features/presence/use-presence";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { membersOptions } from "@/client/api/members";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { personHue } from "@vaskel/ui/components/avatar";
import { PresenceStrip as PresenceStripView } from "@vaskel/ui/components/room";

/** Who is online in this circle, as a link to its People page. */
export function PresenceStrip({ resource }: { resource: ResourceSummary }) {
  const { t, formatNumber } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const members = useQuery({
    ...membersOptions(user.userId, resource.owner),
    enabled: canUseNetwork && resource.owner.kind === "server",
    retry: false,
  });
  const presence = usePresence(
    resource.owner,
    resource.owner.kind === "server",
  );
  // Presence is about other people; the viewer knows they are here.
  const online =
    members.data?.members.filter(
      (member) =>
        presence.state(member.userId) === "online" &&
        member.userId !== user.userId,
    ) ?? [];
  const shown = online.slice(0, 4);
  const { names } = useDisplayNames(shown.map((member) => member.userId));
  if (resource.owner.kind !== "server" || !members.data) return null;
  return (
    <PresenceStripView
      render={(props) => (
        <Link
          {...props}
          to="/servers/$serverId/people"
          params={{ serverId: resource.owner.id }}
          search={{}}
          title={t("workspace.people")}
        />
      )}
      people={shown.map((member) => ({
        name: names.get(member.userId) ?? "?",
        hue: personHue(member.userId),
      }))}
      label={
        !presence.completeFor(
          members.data?.members.map((member) => member.userId) ?? [],
        )
          ? t("workspace.presenceUnavailable")
          : online.length > 0
            ? t("workspace.onlineCount", { count: formatNumber(online.length) })
            : presence.state(user.userId) === "online"
              ? t("workspace.onlyYouOnline")
              : t("workspace.onlineCount", { count: formatNumber(0) })
      }
    />
  );
}
