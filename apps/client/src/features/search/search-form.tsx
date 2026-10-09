import { useEffect, useRef } from "react";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
} from "@vaskel/ui/components/control-styles";
import { Search, X } from "lucide-react";
import {
  SEARCH_TYPING_PAUSE_MS,
  validSearchPhrase,
  type SearchFilters,
} from "./query";

/** Compact filters sit beside the phrase; their current value is their label. */
const filterStyles =
  "min-h-target max-w-full min-w-0 touch-manipulation rounded-lg border border-line bg-surface px-2.5 py-1 text-caption font-medium text-ink";

/**
 * The phrase searches on its own once typing pauses; Enter searches at once
 * and Escape clears. The page owns what is committed and what is shown.
 */
export function SearchForm({
  draft,
  onDraft,
  filters,
  resources,
  online,
  onCommit,
  onRefresh,
  hintId,
}: {
  draft: string;
  onDraft: (value: string) => void;
  /** What the page is showing results for. */
  filters: SearchFilters;
  resources: ResourceSummary[];
  online: boolean;
  onCommit: (next: SearchFilters) => void;
  /** Enter on the phrase already shown re-runs it. */
  onRefresh: () => void;
  hintId: string;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const composing = useRef(false);
  const current = useRef(filters);
  useEffect(() => {
    current.current = filters;
  }, [filters]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const send = (
    phrase: string,
    server = current.current.server,
    channel = current.current.channel,
  ) => {
    clearTimeout(timer.current);
    const q = phrase.trim();
    onCommit({
      ...(validSearchPhrase(q) ? { q } : {}),
      ...(server ? { server } : {}),
      ...(server && channel ? { channel } : {}),
    });
  };
  const schedule = (value: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (validSearchPhrase(value)) send(value);
      else if (current.current.q) send("");
    }, SEARCH_TYPING_PAUSE_MS);
  };
  const clear = () => {
    clearTimeout(timer.current);
    onDraft("");
    if (current.current.q) send("");
    input.current?.focus();
  };
  const servers = resources.filter(
    (resource) => resource.owner.kind === "server",
  );
  const server = filters.server ?? "";
  const channel = filters.channel ?? "";
  const channels =
    servers
      .find((resource) => resource.owner.id === server)
      ?.channels.filter((item) => item.kind === "text") ?? [];
  return (
    <form
      role="search"
      className="border-b border-line px-page-gutter py-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          ref={input}
          type="search"
          className={`${fieldStyles} pr-11 pl-10 [&::-webkit-search-cancel-button]:hidden`}
          value={draft}
          aria-label={t("search.phrase")}
          placeholder={t("search.phrase")}
          aria-describedby={hintId}
          autoComplete="off"
          enterKeyHint="search"
          maxLength={1024}
          disabled={!online}
          autoFocus
          onChange={(event) => {
            const value = event.target.value;
            onDraft(value);
            if (composing.current) clearTimeout(timer.current);
            else schedule(value);
          }}
          onCompositionStart={() => {
            composing.current = true;
            clearTimeout(timer.current);
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            schedule(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (draft || current.current.q) clear();
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            clearTimeout(timer.current);
            const phrase = draft.trim();
            if (!validSearchPhrase(phrase)) return;
            if (phrase === current.current.q) onRefresh();
            else send(phrase);
          }}
        />
        {draft && (
          <button
            type="button"
            className={buttonStyles({
              variant: "muted",
              size: "icon-inset",
              className: "absolute top-1/2 right-1.5 -translate-y-1/2",
            })}
            aria-label={t("search.clear")}
            onClick={clear}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select
          className={filterStyles}
          aria-label={t("search.server")}
          value={server}
          disabled={!online}
          onChange={(event) => send(draft, event.target.value, "")}
        >
          <option value="">{t("search.allServers")}</option>
          {server &&
            !servers.some((resource) => resource.owner.id === server) && (
              <option value={server}>{t("search.selectedServer")}</option>
            )}
          {servers.map((resource) => (
            <option key={resource.owner.id} value={resource.owner.id}>
              {resource.name}
            </option>
          ))}
        </select>
        <select
          className={filterStyles}
          aria-label={t("search.channel")}
          value={channel}
          disabled={!online || !server}
          onChange={(event) => send(draft, server, event.target.value)}
        >
          <option value="">{t("search.allChannels")}</option>
          {channel && !channels.some((item) => item.id === channel) && (
            <option value={channel}>{t("search.selectedChannel")}</option>
          )}
          {channels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <p id={hintId} className={`${fieldHintStyles} mt-2`}>
        {t("search.hint")}
      </p>
    </form>
  );
}
