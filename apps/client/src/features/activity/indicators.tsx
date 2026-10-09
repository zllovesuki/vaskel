import { useI18n } from "@/client/features/i18n/use-i18n";
import { useUser } from "@/client/features/auth/session-state";
import { conversationCounterparts } from "@/client/features/workspace/conversation-title";
import { Link } from "@tanstack/react-router";
import { resourceLocation } from "@/client/routes/resource-location";
import { textButtonStyles } from "@vaskel/ui/components/control-styles";
import { personHue } from "@vaskel/ui/components/avatar";
import { HomeSection, InboxRow, UnreadMark } from "@vaskel/ui/components/home";
import type { UnreadState } from "@/client/features/activity/model";
import type { useActivity } from "@/client/features/activity/use-activity";

export function UnreadIndicator({
  state,
  count = 0,
  mentions = 0,
  quiet = false,
  fresh = false,
}: {
  state: UnreadState | undefined;
  count?: number;
  /** Messages here that name the reader; they lead the badge with an “@”. */
  mentions?: number;
  /** Inside a circle or the Direct messages section: the Unread inbox carries the count, so this row only marks. */
  quiet?: boolean;
  /** A room with messages the viewer has never opened, in a circle new to them. */
  fresh?: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const shown = (value: number) =>
    value >= 100 ? `${formatNumber(99)}+` : formatNumber(value);
  if (state !== "unread")
    return state === "read" ? null : (
      <span className="sr-only">{t("activity.unchecked")}</span>
    );
  if (fresh) return <UnreadMark kind="new" label={t("workspace.new")} />;
  if (mentions > 0) {
    const label = t("workspace.mentionCount", {
      count: shown(mentions),
      unread: shown(Math.max(count, mentions)),
    });
    // Inside a circle the inbox carries the numbers, so a bare accent "@"
    // marks the mention. The inbox badge shows the mentions; its label
    // repeats them as shown, cap included, with the unread total it gives up.
    return quiet ? (
      <UnreadMark kind="mention" label={label} />
    ) : (
      <UnreadMark kind="badge" text={`@ ${shown(mentions)}`} label={label} />
    );
  }
  if (count > 0 && !quiet)
    return (
      <UnreadMark
        kind="badge"
        text={shown(count)}
        label={t("workspace.unreadCount", { count: shown(count) })}
      />
    );
  return (
    <UnreadMark
      kind="dot"
      label={
        count > 0
          ? t("workspace.unreadCount", { count: shown(count) })
          : t("activity.unread")
      }
    />
  );
}
/** The Unread inbox: every room and conversation with unread messages, across circles. */
export function ActivityNavigation({
  activity,
  onNavigate,
}: {
  activity: ReturnType<typeof useActivity>;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const user = useUser();
  const { account, unread, incomplete, online } = activity;
  const notices =
    (online && (account.isError || account.isPending || incomplete)) ||
    account.hasNextPage ||
    (account.data && account.data.pageParams[0] !== null) ||
    (!account.isError &&
      account.data?.pages.some((page) => page.unavailableOwners.length > 0));
  // A quiet sidebar: the "nothing unread" state is announced, not displayed.
  if (unread.length === 0 && !notices)
    return (
      <p role="status" className="sr-only">
        {online ? t("activity.none") : t("activity.offline")}
      </p>
    );
  return (
    <HomeSection
      className="mb-4 text-caption text-muted"
      aria-label={t("activity.privateStatus")}
      label={t("activity.unread")}
    >
      {unread.map((destination) => (
        <InboxRow
          key={`${destination.owner.kind}:${destination.owner.id}:${destination.channelId}`}
          render={(props) => (
            <Link
              {...props}
              {...resourceLocation(destination.owner, destination.channelId)}
              search={{}}
              onClick={onNavigate}
              title={destination.label}
              aria-description={t("activity.privateHint")}
            />
          )}
          name={
            destination.owner.kind === "conversation"
              ? destination.resourceName
              : destination.channelName
          }
          place={
            destination.owner.kind === "server"
              ? destination.resourceName
              : undefined
          }
          hue={
            destination.owner.kind === "conversation"
              ? personHue(
                  conversationCounterparts(destination, user.userId)[0] ??
                    destination.owner.id,
                )
              : undefined
          }
          locked={destination.private}
        >
          <UnreadIndicator
            state="unread"
            count={destination.count}
            mentions={destination.mentionCount}
          />
        </InboxRow>
      ))}
      {online && (account.isError || account.isPending || incomplete) && (
        <p role="status" className="px-2.5 py-1 leading-relaxed">
          {account.isError
            ? t("activity.failed")
            : account.isPending
              ? t("activity.checking")
              : t("activity.partial")}
        </p>
      )}
      {account.isError && (
        <button
          className={textButtonStyles({ size: "small", className: "px-2.5" })}
          disabled={account.isFetching || !online}
          onClick={() => void account.refetch()}
        >
          {t("activity.retry")}
        </button>
      )}
      {account.hasNextPage && (
        <button
          className={textButtonStyles({ size: "small", className: "px-2.5" })}
          disabled={account.isFetching || !online}
          onClick={() => void account.fetchNextPage()}
        >
          {account.isFetchingNextPage
            ? t("activity.checkingMore")
            : t("activity.checkMore")}
        </button>
      )}
      {account.data && account.data.pageParams[0] !== null && (
        <button
          className={textButtonStyles({ size: "small", className: "px-2.5" })}
          disabled={account.isFetching || !online}
          onClick={activity.restart}
        >
          {t("activity.restart")}
        </button>
      )}
      {!account.isError &&
        account.data?.pages.some(
          (page) => page.unavailableOwners.length > 0,
        ) && (
          <button
            className={textButtonStyles({ size: "small", className: "px-2.5" })}
            disabled={account.isFetching || !online}
            onClick={() => void account.refetch()}
          >
            {t("activity.retryUnavailable")}
          </button>
        )}
    </HomeSection>
  );
}
