import type { AccessRecovery } from "./access/presentation";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Link, useParams } from "@tanstack/react-router";
import { resourceLocation } from "@/client/routes/resource-location";
import type {
  CachedAccount,
  CachedSnapshot,
} from "@/client/features/cache/model";
import { TimelineView } from "@/client/features/chat/timeline-view";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { NavRow, wordmarkStyles } from "@vaskel/ui/components/home";

const identity = (snapshot: CachedSnapshot) =>
  `${snapshot.fence.owner.kind}:${snapshot.fence.owner.id}:${snapshot.cursor.channelId}`;

/** Remembered display labels are deliberately separate from authenticated user context. */
export function CachedWorkspace({
  account,
  connection,
  onReconnect,
  onRemove,
}: {
  account: CachedAccount | null;
  connection: AccessRecovery;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const { t, text, formatDateTime } = useI18n();
  const reconnecting = connection.kind === "checking";
  const error = connection.kind === "unavailable" ? connection.error : null;
  const params = useParams({ strict: false });
  const requested = Boolean(params.serverId || params.conversationId);
  const snapshots = account?.snapshots ?? [];
  const current = requested
    ? snapshots.find((snapshot) =>
        params.serverId
          ? snapshot.fence.owner.kind === "server" &&
            snapshot.fence.owner.id === params.serverId &&
            (!params.channelId ||
              snapshot.cursor.channelId === params.channelId)
          : snapshot.fence.owner.kind === "conversation" &&
            snapshot.fence.owner.id === params.conversationId,
      )
    : snapshots[0];
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-surface text-ink sm:flex-row">
      <aside
        className="shrink-0 border-b border-line bg-subtle p-4 sm:w-64 sm:border-r sm:border-b-0"
        aria-label={t("cached.savedConversations")}
      >
        <p className={wordmarkStyles}>
          vaskel<span aria-hidden="true">.</span>
        </p>
        <p className="mt-3 text-ui font-semibold">
          {account?.label ?? t("cached.savedHistory")}
        </p>
        <p className="mt-1 text-caption text-muted">
          {reconnecting ? t("cached.checkingAccess") : t("cached.offline")}
        </p>
        <nav className="mt-4 flex max-h-40 gap-1 overflow-auto sm:max-h-[65vh] sm:flex-col">
          {snapshots.map((snapshot) => (
            <NavRow
              key={identity(snapshot)}
              render={(props) => (
                <Link
                  {...props}
                  {...resourceLocation(
                    snapshot.fence.owner,
                    snapshot.cursor.channelId,
                  )}
                  search={{}}
                />
              )}
              current={current === snapshot}
              // The same rows as Home: the open one lifted, the rest washed on hover.
              className="shrink-0 text-left"
            >
              <span>
                <span className="block text-caption text-muted">
                  {snapshot.labels.owner}
                </span>
                <span className="block">{snapshot.labels.channel}</span>
              </span>
            </NavRow>
          ))}
        </nav>
      </aside>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={t("cached.history")}
      >
        <header className="shrink-0 border-b border-line px-page-gutter py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-base font-semibold">
              {current?.labels.channel ?? t("cached.noMessages")}
            </h1>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonStyles({ size: "small" })}
                disabled={reconnecting}
                onClick={onReconnect}
              >
                {reconnecting
                  ? t("cached.reconnecting")
                  : t("cached.reconnect")}
              </button>
              <button
                className={buttonStyles({ variant: "quiet", size: "small" })}
                onClick={onRemove}
              >
                {t("cached.remove")}
              </button>
            </div>
          </div>
          <p className="mt-2 text-caption text-muted">
            {current
              ? t("cached.savedAt", { date: formatDateTime(current.savedAt) })
              : t("cached.saveHint")}
          </p>
          {error && (
            <p role="status" className="mt-2 text-caption text-error">
              {text(error)}
            </p>
          )}
        </header>
        {current ? (
          <>
            {current.nextBefore !== null && (
              <p className="shrink-0 px-page-gutter py-2 text-center text-caption text-muted">
                {t("cached.moreOnline")}
              </p>
            )}
            <TimelineView
              key={identity(current)}
              owner={current.fence.owner}
              messages={current.messages}
              names={
                new Map(
                  current.labels.authors.map((author) => [
                    author.id,
                    author.label,
                  ]),
                )
              }
            />
          </>
        ) : (
          <p className="px-page-gutter py-8 text-ui text-muted">
            {requested ? t("cached.notSaved") : t("cached.none")}
          </p>
        )}
        <p className="shrink-0 border-t border-line px-page-gutter py-3 text-caption text-muted">
          {t("cached.privacy")}
        </p>
      </section>
    </main>
  );
}
