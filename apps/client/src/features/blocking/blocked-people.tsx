import { useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import type { BlockStatus } from "@vaskel/contracts/blocking";
import { NavigationToggle } from "@vaskel/ui/components/home";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";
import {
  buttonStyles,
  chatHeaderStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import { blockPollInterval, blockedPeopleOptions } from "@/client/api/blocks";
import { errorMessage } from "@/client/api/client";
import { useDisplayNames } from "@/client/api/people";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useUser } from "@/client/features/auth/session-state";
import { useBlockSetting } from "@/client/features/blocking/use-block-setting";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ConfirmRow } from "@/client/ui/confirm-row";
import { Unavailable } from "@/client/ui/failure";
import {
  Bone,
  Line,
  PendingLabel,
  PeopleSkeleton,
} from "@/client/ui/loading-skeleton";
import {
  SettingsSection,
  settingsBodyStyles,
  settingsColumnStyles,
  settingsListStyles,
} from "@/client/ui/settings-section";

/**
 * One blocked person. Unblocking takes the row off the list, so it asks
 * first, in place; the setting shares its command with the direct message
 * control, which stays one click because it stays on screen.
 */
function BlockedRow({
  status,
  name,
  namePending,
  onSettled,
}: {
  status: BlockStatus;
  /** Absent while names load, or when they could not be read. */
  name: string | undefined;
  namePending: boolean;
  onSettled: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A missing name shows as a short account ID, beside the note that explains it.
  const shortId = status.targetId.slice(0, 8);
  const label = name ?? shortId;
  // Unblocked or refused, the question closes and focus waits on the list,
  // since an unblocked row leaves it when the list refreshes.
  const setting = useBlockSetting(status, label, () => {
    setConfirming(false);
    onSettled();
  });
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        {name !== undefined ? (
          <Avatar name={name} hue={personHue(status.targetId)} />
        ) : namePending ? (
          <Bone className="size-9 shrink-0 rounded-[30%]" />
        ) : (
          <Avatar name={shortId} hue={personHue(status.targetId)}>
            <UserRound className="size-4" aria-hidden="true" />
          </Avatar>
        )}
        <span className="min-w-0 flex-1 text-ui font-medium wrap-anywhere">
          {name ??
            (namePending ? (
              <Line width="w-32" />
            ) : (
              <span
                className="font-mono font-normal text-muted"
                title={status.targetId}
              >
                {shortId}
              </span>
            ))}
        </span>
        <button
          ref={trigger}
          type="button"
          className={buttonStyles({
            variant: setting.blocked ? "default" : "quiet",
            size: "small",
            // While its question is open, the question holds the only Unblock.
            className: `shrink-0 ${confirming ? "invisible" : ""}`,
          })}
          // Nobody is unblocked before their name shows.
          disabled={namePending || setting.disabled}
          aria-label={namePending ? undefined : setting.accessibleName}
          onClick={() => {
            if (setting.blocked && !setting.retrying) setConfirming(true);
            else setting.commit();
          }}
        >
          {setting.label}
        </button>
      </div>
      {confirming && (
        <ConfirmRow
          question={t("blocking.unblockConfirm", { name: label })}
          detail={t("blocking.unblockDetail")}
          confirmLabel={t("blocking.unblock")}
          busyLabel={t("blocking.unblocking")}
          busy={setting.pending}
          disabled={setting.disabled}
          returnFocus={trigger}
          onConfirm={setting.commit}
          onCancel={() => setConfirming(false)}
        />
      )}
      {setting.error && (
        <p role="alert" className="mt-2 max-w-prose text-caption text-error">
          {setting.error}
        </p>
      )}
    </li>
  );
}

export function BlockedPeople({ onNavigation }: { onNavigation: () => void }) {
  const { t, text } = useI18n();
  const user = useUser();
  const inbox = useAccountEvents();
  const { canUseNetwork } = useAccess();
  const list = useRef<HTMLUListElement>(null);
  const query = useInfiniteQuery({
    ...blockedPeopleOptions(user.userId, blockPollInterval(inbox.connected)),
    enabled: canUseNetwork,
  });
  const blocks = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.blocks)
        .map((status) => [status.targetId, status]),
    ).values(),
  ];
  const people = useDisplayNames(blocks.map((status) => status.targetId));
  // Names arrive after the list; rows hold placeholders until they do or fail.
  const namesPending = people.isPending && canUseNetwork;
  const namesMissing =
    !namesPending &&
    blocks.some((status) => !people.names.has(status.targetId));
  const partial = query.data?.pages.some((page) => page.partial);
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("blocking.title")}
    >
      <header className={chatHeaderStyles}>
        <NavigationToggle
          action="open"
          label={t("blocking.openConversations")}
          onClick={onNavigation}
        />
        <Avatar name={user.displayName} hue={personHue(user.userId)} />
        <div className="mr-auto min-w-0">
          <h1 className="text-base font-semibold">{t("blocking.title")}</h1>
          <p className="truncate text-caption text-muted">{user.displayName}</p>
        </div>
      </header>
      <div className={settingsBodyStyles}>
        <div className={settingsColumnStyles}>
          {!canUseNetwork && (
            <p role="status" className="mt-5 text-caption text-muted">
              {t("blocking.offline")}
            </p>
          )}
          <SettingsSection
            title={t("blocking.listTitle")}
            description={t("blocking.description")}
            width="full"
          >
            {query.isPending && canUseNetwork && (
              <PeopleSkeleton
                label={t("blocking.loadingPeople")}
                lines={1}
                action="button"
                className={settingsListStyles}
                rowClassName="py-2.5"
              />
            )}
            {(query.error || partial) && (
              <Unavailable
                role="status"
                message={
                  query.error
                    ? text(errorMessage(query.error))
                    : t("blocking.partial")
                }
                onRetry={() => void query.refetch()}
                disabled={!canUseNetwork}
              />
            )}
            {namesMissing && (
              <p role="status" className="text-caption text-muted">
                {t("blocking.namesUnavailable")}
              </p>
            )}
            {query.data &&
              !blocks.length &&
              !partial &&
              !query.error &&
              !query.hasNextPage && (
                <div>
                  <p className="text-ui">{t("blocking.empty")}</p>
                  <p className="mt-1 max-w-[70ch] text-caption leading-relaxed text-muted">
                    {t("blocking.emptyHint")}
                  </p>
                </div>
              )}
            <ul
              ref={list}
              tabIndex={-1}
              aria-label={t("blocking.listTitle")}
              className={`${settingsListStyles} focus-visible:outline-none`}
            >
              {blocks.map((status) => (
                <BlockedRow
                  key={status.targetId}
                  status={status}
                  name={people.names.get(status.targetId)}
                  namePending={namesPending}
                  onSettled={() => list.current?.focus()}
                />
              ))}
            </ul>
            {query.hasNextPage && (
              <button
                className={textButtonStyles({ className: "self-start" })}
                disabled={!canUseNetwork || query.isFetchingNextPage}
                aria-busy={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                <PendingLabel
                  pending={query.isFetchingNextPage}
                  label={t("blocking.loading")}
                >
                  {t("blocking.loadMore")}
                </PendingLabel>
              </button>
            )}
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
