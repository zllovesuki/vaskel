import type { Link, Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkSpoiler } from "./message-spoiler";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { visit } from "unist-util-visit";

import { MessageBodySchema } from "./messaging";

export type { Nodes as MessageNode } from "mdast";

const MENTION_PREFIX = "/mentions/";

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface MentionToken extends TextRange {
  readonly userId: string;
}

/** Stable identity travels in an empty Markdown link, never a display name. */
export function mentionMarkup(userId: string): string {
  // Parentheses and apostrophes are URI-safe but have Markdown meaning.
  const encoded = encodeURIComponent(userId).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[](${MENTION_PREFIX}${encoded})`;
}

function mentionId(node: Link): string | null {
  if (
    node.children.length ||
    node.title ||
    !node.url.startsWith(MENTION_PREFIX)
  )
    return null;
  const encoded = node.url.slice(MENTION_PREFIX.length);
  try {
    const id = decodeURIComponent(encoded);
    // Only the canonical serializer's exact route is reserved. Relative links,
    // noncanonical query strings and malformed escapes remain links.
    return id.length > 0 &&
      id.length <= 128 &&
      mentionMarkup(id) === `[](${node.url})`
      ? id
      : null;
  } catch {
    return null;
  }
}

/** Product adapters only; micromark owns delimiters, escapes and code contexts. */
function messageNodes() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (node.type === "link") {
        const userId = mentionId(node);
        if (userId !== null)
          node.data = {
            hName: "span",
            hProperties: { "data-mention": userId },
          };
      } else if (node.type === "spoiler") {
        node.data = { hName: "span", hProperties: { "data-spoiler": true } };
      }
    });
  };
}

/** Used unchanged by react-markdown and the authoritative owner's parser. */
export const messageRemarkPlugins: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
  remarkSpoiler,
  messageNodes,
];
export const messageMarkdown = unified().use(remarkParse);
messageMarkdown.use(messageRemarkPlugins).freeze();

export function parseMessage(body: string): Root {
  if (!MessageBodySchema.safeParse(body).success)
    return {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: body }] },
      ],
    };
  return messageMarkdown.runSync(messageMarkdown.parse(body)) as Root;
}

/** Syntactic identities only; membership and notification limits belong to the owner. */
export function mentionTokens(body: string): MentionToken[] {
  const mentions: MentionToken[] = [];
  visit(parseMessage(body), "link", (node) => {
    const userId = mentionId(node);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (userId !== null && start !== undefined && end !== undefined)
      mentions.push({ start, end, userId });
  });
  return mentions;
}
