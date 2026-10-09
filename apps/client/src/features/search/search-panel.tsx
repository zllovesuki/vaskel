import {
  PendingLabel,
  ResultsSkeleton,
  Spinner,
} from "@/client/ui/loading-skeleton";
import { NavigationToggle } from "@vaskel/ui/components/home";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { errorMessage } from "@/client/api/client";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { MessageContext } from "@/client/features/chat/message-context";
import { BodyView } from "@/client/features/chat/body-view";
import { MessageFiles } from "@/client/features/files/message-files";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { resourceLocation } from "@/client/routes/resource-location";
import {
  buttonRowStyles,
  buttonStyles,
  chatHeaderStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import {
  crossSearchOptions,
  searchPhraseIssue,
  validSearchPhrase,
  type SearchFilters,
} from "./query";
import { SearchForm } from "./search-form";
import { observeSearchForeground } from "./foreground";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";

export function SearchPanel({
  resources,
  onNavigation,
}: {
  resources: ResourceSummary[];
  onNavigation: () => void;
}) {
  const { t, text, formatDateTime, formatNumber } = useI18n();
  const user = useUser();
  const access = useAccess();
  const filters = useSearch({ strict: false });
  const navigate = useNavigate();
  const hintId = useId();
  const online = access.canUseNetwork;
  const shown = filters.q ?? "";
  const valid = validSearchPhrase(shown);
  // The typed phrase follows the address only when someone else changed it
  // (the Home row, history); the page's own commits leave typing alone.
  const [draft, setDraft] = useState(shown);
  const [applied, setApplied] = useState(shown);
  const [committed, setCommitted] = useState(shown);
  if (shown !== applied) {
    setApplied(shown);
    if (shown !== committed) setDraft(shown);
  }
  const commit = (next: SearchFilters) => {
    setCommitted(next.q ?? "");
    void navigate({ to: "/search", search: next, replace: true });
  };
  const restart = access.invalidateCrossSearch;
  useEffect(() => {
    if (!online || !valid) return;
    return observeSearchForeground(restart);
  }, [online, valid, restart]);
  const results = useInfiniteQuery({
    ...crossSearchOptions(user.userId, filters, access.crossSearchEpoch, {
      capture: access.crossSearchToken,
      current: access.crossSearchCurrent,
    }),
    enabled: online && valid,
  });
  const pages = online ? results.data?.pages : undefined;
  const matches = pages?.at(-1);
  const hits = pages?.flatMap((page) => page.hits) ?? [];
  const coverage = {
    limited: pages?.some((page) => page.coverage.limited) ?? false,
    unavailable: pages?.some((page) => page.coverage.unavailable) ?? false,
  };
  const { names } = useDisplayNames(
    hits.flatMap((hit) => [
      hit.message.authorId,
      ...(hit.message.quote ? [hit.message.quote.authorId] : []),
      ...hit.message.mentions,
    ]),
  );
  const earlierRemoved = matches && results.data?.pageParams[0] !== null;
  // One line always names the state, so results never move when it changes.
  const issue = searchPhraseIssue(draft);
  const waiting = issue === null && draft.trim() !== shown;
  const searching =
    waiting || (results.isFetching && !results.isFetchingNextPage);
  const loading = online && issue === null && searching;
  let status: string;
  let failed = false;
  if (!online) status = t("search.offline");
  else if (issue === "short") status = t("search.minimum");
  else if (issue === "long") status = t("search.tooLong");
  else if (searching) status = t("search.loading");
  else if (results.error) {
    status = text(errorMessage(results.error));
    failed = true;
  } else if (matches)
    status = hits.length
      ? t("search.count", { count: formatNumber(hits.length) })
      : coverage.limited || coverage.unavailable
        ? t("search.incomplete")
        : matches.nextCursor
          ? t("search.emptyPartial")
          : t("search.noMatches");
  else status = t(valid ? "search.incomplete" : "search.minimum");
  const stale = online && (waiting || results.isFetching);
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("search.title")}
    >
      <header className={chatHeaderStyles}>
        <NavigationToggle
          action="open"
          label={t("workspace.openConversations")}
          onClick={onNavigation}
        />
        <h1 className="min-w-0 flex-1 truncate text-chat font-semibold">
          {t("search.title")}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <SearchForm
          draft={draft}
          onDraft={setDraft}
          filters={filters}
          resources={resources}
          online={online}
          onCommit={commit}
          onRefresh={restart}
          hintId={hintId}
        />
        <div className="px-page-gutter py-3">
          <p
            role="status"
            aria-live="polite"
            className={`flex min-h-control-normal items-center gap-1.5 text-caption ${failed ? "text-error" : "text-muted"}`}
          >
            {loading && <Spinner />}
            {status}
          </p>
          {loading && hits.length === 0 && <ResultsSkeleton />}
          {matches && !waiting && (
            <>
              {coverage.limited && (
                <p className="text-caption leading-relaxed text-muted">
                  {t("search.limited")}
                </p>
              )}
              {coverage.unavailable && (
                <p className="text-caption leading-relaxed text-muted">
                  {t("search.unavailable")}
                </p>
              )}
              {earlierRemoved && (
                <p className="text-caption leading-relaxed text-muted">
                  {t("search.earlierRemoved")}
                </p>
              )}
            </>
          )}
          {online && matches && hits.length > 0 && (
            <ul
              className={`mt-1 list-none transition-opacity duration-150 ${stale ? "opacity-60" : ""}`}
              aria-label={t("search.results")}
              aria-busy={stale}
            >
              {hits.map((hit) => {
                const owner = { kind: "server", id: hit.serverId } as const;
                const name =
                  names.get(hit.message.authorId) ?? t("chat.member");
                return (
                  <li
                    key={`${hit.serverId}:${hit.message.id}`}
                    className="border-b border-line last:border-b-0"
                  >
                    <article className="flex gap-3 py-3.5">
                      <Avatar
                        name={name}
                        hue={personHue(hit.message.authorId)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                          <strong className="text-ui font-semibold wrap-anywhere">
                            {name}
                          </strong>
                          <time
                            dateTime={new Date(
                              hit.message.createdAt,
                            ).toISOString()}
                            className="text-fine text-muted"
                          >
                            {formatDateTime(hit.message.createdAt)}
                          </time>
                          <Link
                            {...resourceLocation(owner, hit.channel.id)}
                            search={{}}
                            className="min-w-0 truncate text-fine text-muted no-underline hover:text-ink hover:underline"
                          >
                            {hit.serverName} › #{hit.channel.name}
                          </Link>
                        </div>
                        <MessageContext
                          message={hit.message}
                          owner={owner}
                          names={names}
                          online={online}
                        />
                        <BodyView
                          body={hit.message.body ?? ""}
                          names={names}
                          className="message-body text-chat"
                        />
                        <MessageFiles
                          attachments={hit.message.attachments}
                          owner={owner}
                          online={online}
                        />
                        <Link
                          {...resourceLocation(owner, hit.channel.id)}
                          search={{ at: hit.message.createdSequence }}
                          className={textButtonStyles()}
                        >
                          {t("chat.openAtMessage")}
                        </Link>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
          {online && matches && (
            <div className={`${buttonRowStyles} mt-3`}>
              {results.hasNextPage && (
                <button
                  className={buttonStyles()}
                  disabled={results.isFetching}
                  aria-busy={results.isFetchingNextPage}
                  onClick={() => void results.fetchNextPage()}
                >
                  <PendingLabel
                    pending={results.isFetchingNextPage}
                    label={t("search.loading")}
                  >
                    {t("search.more")}
                  </PendingLabel>
                </button>
              )}
              <button
                className={textButtonStyles()}
                disabled={results.isFetching}
                onClick={restart}
              >
                {t("search.again")}
              </button>
            </div>
          )}
          {online && valid && !results.isFetching && !matches && (
            <div className={`${buttonRowStyles} mt-3`}>
              <button className={buttonStyles()} onClick={restart}>
                {t("search.again")}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
