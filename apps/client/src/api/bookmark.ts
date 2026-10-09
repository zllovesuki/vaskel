// Bookmarks are consistency metadata, never credentials or authorization.
interface PrincipalTransport {
  account: string;
  bookmark: string | null;
  issued: number;
  completed: number;
}
let active: PrincipalTransport | null = null;
export function activateTransport(userId: string) {
  const scope: PrincipalTransport = {
    account: `${location.origin}:${userId}`,
    bookmark: null,
    issued: 0,
    completed: 0,
  };
  active = scope;
  return () => {
    if (active === scope) active = null;
  };
}
export function bookmarkRequest() {
  const scope = active;
  const sequence = scope ? ++scope.issued : 0;
  return {
    header: scope?.bookmark ?? null,
    accept(response: Response) {
      if (!scope || active !== scope || sequence < scope.completed) return;
      scope.completed = sequence;
      const bookmark = response.headers.get("X-Vaskel-D1-Bookmark");
      if (bookmark && bookmark.length <= 256 && /^[\x20-\x7e]+$/.test(bookmark))
        scope.bookmark = bookmark;
    },
  };
}
