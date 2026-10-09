import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import Markdown, { type Components } from "react-markdown";
import { visit } from "unist-util-visit";
import { messageRemarkPlugins } from "@vaskel/contracts/message-text";
import { MessageBodySchema } from "@vaskel/contracts/messaging";
import { useI18n } from "@/client/features/i18n/use-i18n";

/** Display names for the accounts a body mentions, as the caller knows them. */
export type MentionNames = ReadonlyMap<string, string>;
const Names = createContext<MentionNames | undefined>(undefined);
const tableCellStyles = "border border-line px-3 py-1";

const components: Components = {
  a: ({ href, children, node }) => {
    let interactiveLabel = false;
    if (node)
      visit(node, "element", (child) => {
        if (child.properties["data-spoiler"]) interactiveLabel = true;
      });
    // A reveal button cannot live inside an anchor. A link with a spoiler in
    // its label displays the label only; links inside a spoiler still work.
    return !interactiveLabel &&
      href &&
      /^(?:https?:\/\/|mailto:)/iu.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="wrap-anywhere"
      >
        {children}
      </a>
    ) : (
      <>{children}</>
    );
  },
  // Private attachments have their own authenticated renderer. Markdown never
  // loads author-controlled remote images (including tracking pixels).
  img: ({ alt }) => <>{alt}</>,
  p: ({ children }) => (
    <p className="my-1 first:mt-0 last:mb-0 last-of-type:inline">{children}</p>
  ),
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-[0.9em] leading-snug">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.92em]">
      {children}
    </code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-s-2 border-line ps-3">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc ps-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal ps-6">{children}</ol>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="my-2 border-collapse">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className={tableCellStyles} style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={tableCellStyles} style={style}>
      {children}
    </td>
  ),
  span: ({ node, children }) => {
    const userId = node?.properties["data-mention"];
    if (typeof userId === "string") return <Mention userId={userId} />;
    if (node?.properties["data-spoiler"]) return <Spoiler>{children}</Spoiler>;
    return <span>{children}</span>;
  },
};

/** Library-owned CommonMark/GFM parsing; raw HTML is escaped by react-markdown. */
export function BodyView({
  body,
  className,
  id,
  ref,
  names,
  trailing,
}: {
  body: string;
  className?: string | undefined;
  id?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
  names?: MentionNames | undefined;
  trailing?: ReactNode;
}) {
  return (
    <div
      ref={ref}
      id={id}
      className={`wrap-anywhere${className ? ` ${className}` : ""}`}
    >
      <Names value={names}>
        {MessageBodySchema.safeParse(body).success ? (
          <Markdown
            remarkPlugins={messageRemarkPlugins}
            components={components}
          >
            {body}
          </Markdown>
        ) : (
          body
        )}
      </Names>
      {trailing}
    </div>
  );
}

function Mention({ userId }: { userId: string }) {
  const { t } = useI18n();
  const names = useContext(Names);
  return (
    <span className="mention rounded bg-accent-soft px-1 py-0.5 font-medium text-accent">
      {`@${names?.get(userId) ?? t("chat.member")}`}
    </span>
  );
}

/** Concealed links stay unfocusable; the reveal button never contains anchors. */
function Spoiler({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  // The hidden span is the control itself: an overlay button positioned over an
  // inline span collapses when the spoiler wraps onto a second line, so taps on
  // a wrapped spoiler would reach nothing. A span keeps wrapping intact.
  return (
    <span
      role={revealed ? undefined : "button"}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : t("chat.revealSpoiler")}
      onClick={revealed ? undefined : () => setRevealed(true)}
      onKeyDown={
        revealed
          ? undefined
          : (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setRevealed(true);
            }
      }
      className={`rounded px-0.5 ${revealed ? "bg-subtle text-ink" : "cursor-pointer bg-ink"}`}
      data-revealed={revealed || undefined}
    >
      <span
        inert={!revealed}
        aria-hidden={!revealed}
        className={revealed ? undefined : "invisible select-none"}
      >
        {children}
      </span>
    </span>
  );
}
