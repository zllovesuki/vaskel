import { usePresence } from "@/client/features/presence/use-presence";
import { DraftBadge } from "@/client/features/drafts/badge";
import { Link } from "@tanstack/react-router";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { UnreadIndicator } from "@/client/features/activity/indicators";
import type { UnreadState } from "@/client/features/activity/model";
import { useUser } from "@/client/features/auth/session-state";
import { conversationCounterparts } from "@/client/features/workspace/conversation-title";
import { DirectRow as DirectRowView } from "@vaskel/ui/components/home";
import { personHue } from "@vaskel/ui/components/avatar";

/** One conversation in Home: the counterpart's name, hue and presence. */
export function DirectRow({
  resource,
  active,
  state,
  count,
  mentions,
  onNavigate,
}: {
  resource: ResourceSummary;
  active: boolean;
  state: UnreadState | undefined;
  count: number;
  mentions: number;
  onNavigate: () => void;
}) {
  const user = useUser();
  const counterpart = conversationCounterparts(resource, user.userId)[0];
  const presence = usePresence(resource.owner);
  return (
    <DirectRowView
      render={(props) => (
        <Link
          {...props}
          to="/conversations/$conversationId"
          params={{ conversationId: resource.owner.id }}
          search={{}}
          onClick={onNavigate}
        />
      )}
      name={resource.name}
      hue={personHue(counterpart ?? resource.owner.id)}
      online={presence.state(counterpart) === "online"}
      current={active}
      unread={state === "unread"}
    >
      <DraftBadge owner={resource.owner} channelId={resource.owner.id} />
      <UnreadIndicator state={state} count={count} mentions={mentions} quiet />
    </DirectRowView>
  );
}
