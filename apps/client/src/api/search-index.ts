import { type RebuildSearchIndexesSummary } from "@vaskel/contracts/search";
import { rawRoutes } from "@vaskel/contracts/api";
import { RebuildSearchIndexesEventSchema } from "@vaskel/contracts/search";
import { ApiError, requestStream } from "./client";
import { sseData } from "./sse";

export function rebuildSearchIndexes(
  progress: (counts: Omit<RebuildSearchIndexesSummary, "type">) => void,
  signal: AbortSignal,
): Promise<RebuildSearchIndexesSummary> {
  return requestStream(
    rawRoutes.rebuildSearch.path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    },
    async (response, checkCurrent) => {
      const invalid = () =>
        new ApiError("unavailable", response.status, "contract");
      if (
        !response.body ||
        response.headers.get("Content-Type")?.split(";")[0] !==
          "text/event-stream"
      )
        throw invalid();
      for await (const data of sseData(response.body, signal, checkCurrent)) {
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          throw invalid();
        }
        const event = RebuildSearchIndexesEventSchema.safeParse(value);
        if (!event.success) throw invalid();
        checkCurrent();
        if (event.data.type === "error")
          throw new ApiError(event.data.kind, response.status, "http");
        if (event.data.type === "complete") return event.data;
        progress(event.data);
      }
      // A normal-looking EOF may be a broken connection or an aborted Worker.
      throw invalid();
    },
    rawRoutes.rebuildSearch,
  );
}
