import { useState } from "react";
import { Search } from "lucide-react";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { ResultsSkeleton } from "@/client/ui/loading-skeleton";
import { Failure } from "@/client/ui/failure";
import { Popover } from "@/client/ui/popover";
import { MessageFiles } from "@/client/features/files/message-files";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { BodyView } from "./body-view";
import { MessageContext } from "./message-context";
import type { ConversationSearch } from "./use-conversation-search";
import {
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  formStyles,
  labelStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";

export function ConversationSearchResults({
  search,
  owner,
  names,
  online,
}: {
  search: ConversationSearch;
  owner: OwnerScope;
  names: Map<string, string>;
  online: boolean;
}) {
  const { t, formatDate } = useI18n();
  const { query } = search;
  if (!query) return null;
  return (
    <aside
      className={`shrink-0 border-b border-line bg-surface px-page-gutter py-3 ${search.collapsed ? "" : "max-h-[45%] overflow-auto"}`}
      aria-label={t("chat.searchResults")}
    >
      <div className="flex items-start justify-between gap-3 sm:items-center">
        <h2 className="text-ui wrap-anywhere">
          {t("chat.resultsFor", { query })}
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {search.collapsed && (
            <button className={textButtonStyles()} onClick={search.showResults}>
              {t("chat.showResults")}
            </button>
          )}
          <button className={textButtonStyles()} onClick={search.close}>
            {t("chat.closeSearch")}
          </button>
        </div>
      </div>
      {!search.collapsed &&
        (search.results.isPending ? (
          <ResultsSkeleton
            label={t("chat.searching")}
            avatar={false}
            rows={2}
          />
        ) : search.results.error ? (
          <Failure error={search.results.error} />
        ) : !search.results.data?.messages.length ? (
          <p className="text-muted">{t("chat.noSearchMatches")}</p>
        ) : (
          <div>
            {search.results.data.messages.map((message) => (
              <article key={message.id} className="border-b border-line py-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <strong className="text-caption">
                    {names.get(message.authorId) ?? t("chat.member")}
                  </strong>
                  <time className="text-fine text-muted">
                    {formatDate(message.createdAt)}
                  </time>
                </div>
                <MessageContext
                  message={message}
                  owner={owner}
                  names={names}
                  online={online}
                />
                <BodyView
                  body={message.body ?? ""}
                  names={names}
                  className="message-body text-ui"
                />
                {!message.deletedAt && (
                  <MessageFiles
                    attachments={message.attachments}
                    owner={owner}
                    online={online}
                  />
                )}
                <button
                  className={textButtonStyles()}
                  onClick={() => search.open(message.createdSequence)}
                >
                  {t("chat.openAtMessage")}
                </button>
              </article>
            ))}
            {search.results.data.messages.length === 40 && (
              <p className="text-muted">{t("chat.searchLimit")}</p>
            )}
          </div>
        ))}
    </aside>
  );
}

export function ConversationSearchControl({
  search,
}: {
  search: ConversationSearch;
}) {
  const { t } = useI18n();
  return (
    <Popover
      buttonClass={buttonStyles({
        variant: "quiet",
        size: "small",
        className: "max-sm:px-2",
      })}
      label={
        <>
          <Search className="size-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">{t("chat.search")}</span>
        </>
      }
    >
      {(close) => (
        <SearchForm
          initial={search.query ?? ""}
          submit={(query) => {
            search.submit(query);
            close();
          }}
        />
      )}
    </Popover>
  );
}

function SearchForm({
  initial,
  submit,
}: {
  initial: string;
  submit: (query: string) => void;
}) {
  const { t } = useI18n();

  const [query, setQuery] = useState(initial);
  const length = Array.from(query.trim()).length;
  return (
    <form
      className={formStyles}
      onSubmit={(event) => {
        event.preventDefault();
        if (length >= 3 && length <= 256) submit(query.trim());
      }}
    >
      <h2>{t("chat.searchConversation")}</h2>
      <label className={labelStyles}>
        {t("chat.searchPhrase")}
        <input
          className={fieldStyles}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
          placeholder={t("chat.searchPlaceholder")}
        />
      </label>
      <p className={fieldHintStyles}>{t("chat.searchHint")}</p>
      <button
        className={buttonStyles({ variant: "primary" })}
        disabled={length < 3 || length > 256}
      >
        {t("chat.searchMessages")}
      </button>
    </form>
  );
}
