import type { ResourceSummary } from "@vaskel/contracts/directory";

/** The other participants of a conversation, in delivered order. */
export function conversationCounterparts(
  resource: Pick<ResourceSummary, "owner" | "participantIds">,
  userId: string,
): string[] {
  if (resource.owner.kind !== "conversation" || !resource.participantIds)
    return [];
  return resource.participantIds.filter((id) => id !== userId);
}

/**
 * Names the conversation after the people in it, in the viewer's language,
 * or returns null until every counterpart's name is known so the directory
 * name stays the fallback.
 */
export function conversationTitle(
  resource: ResourceSummary,
  userId: string,
  names: ReadonlyMap<string, string>,
  language: string,
): string | null {
  const others = conversationCounterparts(resource, userId);
  const resolved = others.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
  if (others.length === 0 || resolved.length !== others.length) return null;
  return new Intl.ListFormat(language, {
    style: "long",
    type: "conjunction",
  }).format(resolved);
}

/** The same resource with its conversation title resolved when it can be. */
export function titledResource(
  resource: ResourceSummary,
  userId: string,
  names: ReadonlyMap<string, string>,
  language: string,
): ResourceSummary {
  const title = conversationTitle(resource, userId, names, language);
  return title === null ? resource : { ...resource, name: title };
}
