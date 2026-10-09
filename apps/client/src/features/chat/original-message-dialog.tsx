import { Line, Placeholder } from "@/client/ui/loading-skeleton";
import { MessageFiles } from "@/client/features/files/message-files";
import { BodyView } from "@/client/features/chat/body-view";
import { QuoteView } from "@/client/features/chat/quote-view";
import { ModalDialog } from "@/client/ui/dialog";
import { Unavailable } from "@/client/ui/failure";
import { type QuoteReference } from "@vaskel/contracts/messaging";
import { api } from "@/client/api/contract";

import { useQuery } from "@tanstack/react-query";

import { errorMessage, privateKey } from "@/client/api/client";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";

import { quoteKind } from "@/client/features/chat/quote-selection";

/** This exact-message read never changes the selected channel or its read cursor. */
export function OriginalMessageDialog({
  source,
  close,
}: {
  source: QuoteReference;
  close: () => void;
}) {
  const { t, text, formatDateTime } = useI18n();
  const user = useUser();
  const access = useAccess();
  const token = access.ownerToken(source.owner);
  const online = access.canUseNetwork;
  const original = useQuery({
    queryKey: [
      ...privateKey(user.userId),
      "original-message",
      source.owner.kind,
      source.owner.id,
      source.channelId,
      source.messageId,
      token,
    ],
    queryFn: ({ signal }) =>
      api.originalMessage(
        {
          params: source.owner,
          body: { channelId: source.channelId, messageId: source.messageId },
        },
        { signal: signal },
      ),
    enabled: online,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const message =
    online && !original.error ? original.data?.message : undefined;
  const ids = message
    ? [
        message.authorId,
        ...(message.quote ? [message.quote.authorId] : []),
        ...message.mentions,
      ]
    : [];
  const { names } = useDisplayNames(ids);
  return (
    <ModalDialog title={t("chat.originalMessage")} width="wide" close={close}>
      {!online ? (
        <p role="status" className="text-caption text-muted">
          {t("chat.checkingAccess")}
        </p>
      ) : original.isPending ? (
        <Placeholder label={t("chat.loading")} kind="message">
          <div className="flex flex-wrap items-baseline gap-2">
            <Line width="w-28" />
            <Line size="fine" width="w-24" />
          </div>
          <div className="message-body">
            <Line size="chat" width="w-[85%]" />
            <Line size="chat" width="w-[60%]" />
          </div>
        </Placeholder>
      ) : original.error ? (
        <Unavailable
          message={text(errorMessage(original.error))}
          onRetry={() => void original.refetch()}
          disabled={!online}
        />
      ) : (
        message && (
          <article>
            <div className="flex flex-wrap items-baseline gap-2">
              <strong className="text-ui">
                {names.get(message.authorId) ?? t("chat.member")}
              </strong>
              <time
                className="text-fine text-muted"
                dateTime={new Date(message.createdAt).toISOString()}
              >
                {formatDateTime(message.createdAt)}
              </time>
            </div>
            {message.quote && (
              <QuoteView
                quote={message.quote}
                kind={quoteKind(
                  message.quote.source,
                  source.owner,
                  source.channelId,
                )}
                name={names.get(message.quote.authorId)}
                names={names}
              />
            )}
            <BodyView
              body={message.body ?? ""}
              names={names}
              className="message-body text-chat"
            />
            <MessageFiles
              attachments={message.attachments}
              owner={source.owner}
              online={online}
            />
          </article>
        )
      )}
    </ModalDialog>
  );
}
