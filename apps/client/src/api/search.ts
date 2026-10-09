import { type CrossSearchRequest } from "@vaskel/contracts/search";
import { api } from "@/client/api/contract";
import { type CrossSearchResponse } from "@vaskel/contracts/search";

export type SearchPage = Extract<
  CrossSearchResponse,
  { kind: "cross_matches" }
>;

export interface SearchFence {
  capture(): string;
  current(token: string): boolean;
}

export async function searchServers(
  input: CrossSearchRequest,
  signal: AbortSignal,
  fence: SearchFence,
): Promise<SearchPage> {
  const token = fence.capture();
  const check = () => {
    if (signal.aborted || !fence.current(token))
      throw new DOMException("The request was canceled.", "AbortError");
  };
  check();
  const response = await api.search({ body: input }, { signal: signal });
  check();
  return response;
}
