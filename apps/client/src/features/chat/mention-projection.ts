import type { Link, Parent, RootContent, Text } from "mdast";
import { decodeString } from "micromark-util-decode-string";
import { gfmToMarkdown } from "mdast-util-gfm";
import { spoilerToMarkdown } from "mdast-util-inline-spoiler/dist/index.esm.js";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import {
  mentionMarkup,
  messageMarkdown,
  type MentionToken,
} from "@vaskel/contracts/message-text";
import { MessageBodySchema } from "@vaskel/contracts/messaging";

type Label = { text: string; userId: string };
const fields = [
  "value",
  "url",
  "title",
  "alt",
  "lang",
  "meta",
  "identifier",
  "label",
] as const;

/** Library parsing/serialization keeps selected display names literal atoms. */
export function encodeMentions(
  body: string,
  mentions: readonly MentionToken[],
): string {
  let end = 0;
  const ranges = [...mentions]
    .sort((a, b) => a.start - b.start)
    .filter((range) => {
      if (
        range.start < end ||
        range.end > body.length ||
        !body.slice(range.start, range.end).startsWith("@")
      )
        return false;
      end = range.end;
      return true;
    });
  if (!ranges.length) return body;
  const substitute = (
    value: (range: MentionToken, index: number) => string,
  ) => {
    let result = "";
    let start = 0;
    ranges.forEach((range, index) => {
      result += body.slice(start, range.start) + value(range, index);
      start = range.end;
    });
    return result + body.slice(start);
  };
  const wire = substitute((range) => mentionMarkup(range.userId));
  // Count the transmitted identity atoms, not expanded directory labels.
  if (!MessageBodySchema.safeParse(wire).success) return wire;
  const decoded = decodeString(body).toLowerCase();
  let prefixIndex = 0;
  while (decoded.includes(`cm${prefixIndex}x`)) prefixIndex++;
  const prefix = `cm${prefixIndex}x`;
  const labels = new Map<string, Label>();
  const projected = substitute((range, index) => {
    const marker = `${prefix}${index}end`;
    labels.set(marker, {
      text: body.slice(range.start, range.end),
      userId: range.userId,
    });
    return marker;
  });
  const pattern = new RegExp(`${prefix}\\d+end`, "gu");
  const restore = (value: string) =>
    value.replace(pattern, (marker) => labels.get(marker)?.text ?? marker);
  // Alphanumeric temporary atoms are shorter than their bounded wire links.
  // Parse without rendering transforms; the serializer owns escaping/fences.
  const tree = messageMarkdown.parse(projected);
  visit(tree, (node, index, parent) => {
    if (node.type === "link" || node.type === "linkReference") {
      let selectedLabel = false;
      visit(node, "text", (text) => {
        if (
          [...text.value.matchAll(pattern)].some((match) =>
            labels.has(match[0]),
          )
        )
          selectedLabel = true;
      });
      if (selectedLabel && parent && index !== undefined) {
        (parent as Parent).children.splice(index, 1, ...node.children);
        return index;
      }
    }
    if (
      node.type === "text" &&
      node.value.includes(prefix) &&
      parent &&
      index !== undefined
    ) {
      const children: (Text | Link)[] = [];
      let start = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > start)
          children.push({
            type: "text",
            value: node.value.slice(start, match.index),
          });
        const label = labels.get(match[0]);
        if (!label) {
          children.push({ type: "text", value: match[0] });
          start = match.index + match[0].length;
          continue;
        }
        children.push({
          type: "link",
          url: mentionMarkup(label.userId).slice(3, -1),
          children: [],
        });
        start = match.index + match[0].length;
      }
      if (start < node.value.length)
        children.push({ type: "text", value: node.value.slice(start) });
      (parent as Parent).children.splice(index, 1, ...children);
      return index + children.length;
    }
    const scalar = node as RootContent &
      Partial<Record<(typeof fields)[number], string | null>>;
    for (const field of fields) {
      const value = scalar[field];
      if (typeof value === "string") scalar[field] = restore(value);
    }
    if (node.type === "html" && parent && index !== undefined) {
      const text: Text = { type: "text", value: node.value };
      (parent as Parent).children[index] = [
        "root",
        "blockquote",
        "listItem",
      ].includes(parent.type)
        ? { type: "paragraph", children: [text] }
        : text;
    }
  });
  return toMarkdown(tree, {
    extensions: [gfmToMarkdown(), spoilerToMarkdown()],
  }).replace(/\n$/u, "");
}
