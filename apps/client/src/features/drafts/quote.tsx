import { Line, Placeholder } from "@/client/ui/loading-skeleton";
import { QuoteView } from "@/client/features/chat/quote-view";
import { type QuoteReference } from "@vaskel/contracts/messaging";
import { type QuoteSelection } from "@/client/features/chat/quote-selection";
import { api } from "@/client/api/contract";
import { useQuery } from "@tanstack/react-query";
import { Forward, Reply } from "lucide-react";

import { privateKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { selectQuote } from "@/client/features/chat/quote-selection";

import { peopleByIdOptions } from "@/client/api/people";

/** Disk retains only a reference; private quoted text is read under current access. */
export function DraftQuote({
  reference,
  preview,
  online,
  kind,
}: {
  reference: QuoteReference;
  preview: QuoteSelection | null;
  online: boolean;
  /** Reply within the destination, or a forward carried in from elsewhere. */
  kind: "reply" | "forward";
}) {
  const user = useUser();
  const access = useAccess();
  const { t } = useI18n();
  const Marker = kind === "forward" ? Forward : Reply;
  const denied = access.deniedOwners.includes(
    `${reference.owner.kind}:${reference.owner.id}`,
  );
  const original = useQuery({
    queryKey: [
      ...privateKey(user.userId),
      "draft-quote",
      reference.owner.kind,
      reference.owner.id,
      reference.channelId,
      reference.messageId,
      access.ownerToken(reference.owner),
      access.crossSearchEpoch,
    ],
    queryFn: ({ signal }) =>
      api.originalMessage(
        {
          params: reference.owner,
          body: {
            channelId: reference.channelId,
            messageId: reference.messageId,
          },
        },
        { signal: signal },
      ),
    enabled: online && !preview && !denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const quote = !denied
    ? (preview?.preview ??
      (original.data?.message
        ? selectQuote(reference.owner, original.data.message).preview
        : null))
    : null;
  const profiles = useQuery({
    ...peopleByIdOptions(user.userId, quote ? [quote.authorId] : []),
    enabled: online && Boolean(quote),
  });
  return quote ? (
    <QuoteView
      quote={quote}
      kind={kind}
      name={profiles.data?.[0]?.displayName}
      plain
    />
  ) : original.isPending && online && !denied ? (
    <Placeholder label={t("drafts.loadingQuote")} kind="quote">
      <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 gap-y-0.5 py-1 text-caption text-muted">
        <Marker
          className="mt-0.5 size-4 justify-self-center"
          aria-hidden="true"
        />
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Line size="caption" width="w-24" />
          <Line size="caption" width="w-10" />
        </div>
        <Line size="caption" width="w-64" className="col-start-2" />
      </div>
    </Placeholder>
  ) : (
    <p className="py-2 text-caption text-muted" role="status">
      {t("drafts.quoteUnavailable")}
    </p>
  );
}
