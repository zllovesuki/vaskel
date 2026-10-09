import { failureResponse, fetchRequest } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import { message } from "@/client/features/i18n/messages";
import { I18nProvider } from "@lingui/react";
import { createI18n } from "@/client/features/i18n/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiContract } from "@vaskel/contracts/api";
import { detectInlineContentType } from "@vaskel/contracts/attachments";
import type { IdentityProfile } from "@vaskel/contracts/identity";

let MessageRow: typeof import("@/client/features/chat/message-row").MessageRow;
let uploadTransport: typeof import("@/client/features/files/transport").uploadTransport;
let MediaViewerContext: typeof import("@/client/features/files/viewer-context").MediaViewerContext;
let attachmentGrantOptions: typeof import("@/client/features/files/use-attachment-grant").attachmentGrantOptions;
let UserContext: typeof import("@/client/features/auth/session-state").UserContext;
const owner = { kind: "server", id: "server-a" } as const;
const file = new File(["日本語 content"], "共有資料.txt", {
  type: "text/plain",
});
const fileId = "00000000-0000-4000-8000-000000000001";
const attachment = { fileId, filename: file.name, byteLength: file.size };
const user = { userId: "account" } as unknown as IdentityProfile;
const grantUrl = "/api/files/test-grant";
const pngBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1,
]);
const ascii = (value: string) => Array.from(value, (c) => c.charCodeAt(0));
const ebml = [
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
];
const webmBytes = new Uint8Array([...ebml, 0x42, 0x82, 0x84, ...ascii("webm")]);

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  ({ MessageRow } = await import("@/client/features/chat/message-row"));
  ({ uploadTransport } = await import("@/client/features/files/transport"));
  ({ MediaViewerContext } =
    await import("@/client/features/files/viewer-context"));
  ({ attachmentGrantOptions } =
    await import("@/client/features/files/use-attachment-grant"));
  ({ UserContext } = await import("@/client/features/auth/session-state"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One static render over a query cache that already holds, lacks or refused the grant. */
function renderEnglish(
  child: ReactNode,
  options: {
    grant?: "seeded" | "failed";
    viewer?: boolean;
    fileIds?: string[];
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const id of options.fileIds ?? [fileId]) {
    const { queryKey } = attachmentGrantOptions(user.userId, owner, id);
    if (options.grant === "seeded")
      client.setQueryData(queryKey, {
        url: grantUrl,
        expiresAt: Date.now() + 3_600_000,
      });
    if (options.grant === "failed")
      client
        .getQueryCache()
        .build(client, { queryKey })
        .setState({
          status: "error",
          error: new Error("grant refused"),
          fetchStatus: "idle",
        } as never);
  }
  let tree: ReactNode = createElement(QueryClientProvider, { client }, child);
  if (options.viewer)
    tree = createElement(MediaViewerContext, { value: () => {} }, tree);
  tree = createElement(UserContext, { value: user }, tree);
  return renderToStaticMarkup(
    createElement(I18nProvider, { i18n: createI18n("en").runtime }, tree),
  );
}

describe("attachment message rendering and cancel responses", () => {
  it("renders CJK downloads only for live authorized message rows, including blank captions", () => {
    const message = {
      id: "message-a",
      channelId: "channel-a",
      authorId: "member-a",
      body: "",
      attachments: [attachment],
      version: 1,
      createdSequence: 1,
      updatedSequence: 1,
      createdAt: 100,
      updatedAt: 100,
      deletedAt: null,
      reactions: [],
      mentions: [],
    };
    const props = {
      message,
      owner,
      name: "Member",
      own: false,
      online: true,
      command: async () => {},
    };
    const live = renderEnglish(createElement(MessageRow, props), {
      grant: "seeded",
    });
    expect(live).toContain("共有資料.txt");
    expect(live).toContain(`href="${grantUrl}"`);
    expect(live).not.toContain("/content");
    const offline = renderEnglish(
      createElement(MessageRow, { ...props, online: false }),
      { grant: "seeded" },
    );
    expect(offline).toContain("Reconnect to download");
    expect(offline).not.toContain("href=");
    // Even a stale local descriptor cannot escape through tombstone rendering.
    const deleted = renderEnglish(
      createElement(MessageRow, {
        ...props,
        message: { ...message, body: null, deletedAt: 200 },
      }),
      { grant: "seeded" },
    );
    expect(deleted).toContain("Message deleted");
    expect(deleted).not.toContain("共有資料.txt");
    expect(deleted).not.toContain("/api/files/");
  });

  it("uses contentless POST cancellation and treats a concurrent accepted claim as a reconciliation signal", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        failureResponse({ kind: "attachment_claimed", messageId: "message-a" }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      uploadTransport(owner, "channel-a").cancel(
        fileId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ uiMessage: message("files.alreadySent") });
    const request = fetchRequest(
      fetch.mock.calls[0]![0],
      fetch.mock.calls[0]![1],
    );
    expect(new URL(request.url).pathname).toBe(
      `/api/resources/server/server-a/files/${fileId}/cancel`,
    );
    expect(request).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
    expect(request.body).toBeNull();
  });
});

describe("inline media admission", () => {
  it("admits image and video containers from leading bytes only", async () => {
    const { automaticVideoPlayback, detectRasterContentType } =
      await import("@/client/features/files/raster-image");
    const mp4 = new Uint8Array([0, 0, 0, 24, ...ascii("ftypisom"), 0, 0, 0, 1]);
    const quicktime = new Uint8Array([0, 0, 0, 20, ...ascii("ftypqt  ")]);
    const matroska = new Uint8Array([
      ...ebml,
      0x42,
      0x82,
      0x88,
      ...ascii("matroska"),
    ]);
    expect(detectInlineContentType(pngBytes)).toBe("image/png");
    expect(detectInlineContentType(mp4)).toBe("video/mp4");
    expect(detectInlineContentType(quicktime)).toBe("video/quicktime");
    expect(detectInlineContentType(webmBytes)).toBe("video/webm");
    expect(detectInlineContentType(matroska)).toBeNull();
    expect(
      detectInlineContentType(new TextEncoder().encode("<svg xmlns='x'/>")),
    ).toBeNull();
    expect(detectInlineContentType(new Uint8Array(3))).toBeNull();
    expect(detectRasterContentType(pngBytes)).toBe("image/png");
    expect(detectRasterContentType(webmBytes)).toBeNull();
    expect(automaticVideoPlayback("Clip.MOV")).toBe(true);
    expect(automaticVideoPlayback("clip.webm.txt")).toBe(false);
  });

  it("keeps a refused grant local to its file", async () => {
    const { grantUsable } =
      await import("@/client/features/files/use-attachment-grant");
    const { localFailure } =
      await import("@/client/features/cache/access/request-policy");
    const { ApiError } = await import("@/client/api/client");
    expect(apiContract.fileGrant["~orpc"].meta.authority).toBe("message");
    const refused = new ApiError("not_found", 404, "http");
    expect(localFailure({ authority: "message", owner }, refused)).toBe(true);
    expect(localFailure({ authority: "resource", owner }, refused)).toBe(false);
    const now = 1_000_000;
    expect(
      grantUsable({ url: grantUrl, expiresAt: now + 3_600_000 }, now),
    ).toBe(true);
    expect(grantUsable({ url: grantUrl, expiresAt: now + 300_000 }, now)).toBe(
      false,
    );
    expect(grantUsable({ url: grantUrl, expiresAt: now - 1 }, now)).toBe(false);
  });
});

describe("local raster previews", () => {
  it("uses detected raster bytes rather than filename or declared MIME and falls back after decoding fails", async () => {
    const { PreviewResource } =
      await import("@/client/features/files/preview-resource");
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:vaskel-preview");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const preview = new PreviewResource();
    await preview.load(
      new File(
        ["<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
        "image.png",
        { type: "image/png" },
      ),
    );
    expect(preview.getSnapshot()).toEqual({ phase: "unsupported" });
    expect(create).not.toHaveBeenCalled();
    await preview.load(
      new Blob([pngBytes], { type: "application/octet-stream" }),
    );
    expect(preview.getSnapshot()).toEqual({
      phase: "decoding",
      url: "blob:vaskel-preview",
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ type: "image/png" });
    preview.failed("blob:vaskel-preview");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:vaskel-preview");
    expect(preview.getSnapshot()).toEqual({ phase: "unavailable" });
    preview.decoded("blob:vaskel-preview");
    expect(preview.getSnapshot()).toEqual({ phase: "unavailable" });
    preview.dispose();
  });

  it("retires object URLs on replacement and lets a superseded load publish nothing", async () => {
    const { PreviewResource } =
      await import("@/client/features/files/preview-resource");
    let next = 0;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:preview-${++next}`);
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const preview = new PreviewResource();
    const raster = new Blob([pngBytes]);
    const held = deferred<ArrayBuffer>();
    const slow = {
      size: pngBytes.byteLength,
      slice: () => ({ arrayBuffer: () => held.promise }),
    } as unknown as Blob;
    const first = preview.load(slow);
    preview.dispose();
    await preview.load(raster);
    preview.decoded("blob:preview-1");
    const current = preview.getSnapshot();
    held.resolve(pngBytes.buffer as ArrayBuffer);
    await first;
    expect(preview.getSnapshot()).toBe(current);
    expect(create).toHaveBeenCalledTimes(1);
    expect(current).toEqual({ phase: "ready", url: "blob:preview-1" });
    await preview.load(raster);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
    expect(preview.getSnapshot()).toEqual({
      phase: "decoding",
      url: "blob:preview-2",
    });
    preview.dispose();
    expect(revoke).toHaveBeenLastCalledWith("blob:preview-2");
    expect(preview.getSnapshot()).toEqual({ phase: "idle" });
  });
});

describe("sent attachment rows", () => {
  const files = async () =>
    (await import("@/client/features/files/message-files")).MessageFiles;

  it("loads image previews from the granted URL and keeps filenames as hints", async () => {
    const MessageFiles = await files();
    const { automaticImagePreview } =
      await import("@/client/features/files/raster-image");
    expect(automaticImagePreview("資料.JPG")).toBe(true);
    expect(automaticImagePreview("資料")).toBe(false);
    const image = renderEnglish(
      createElement(MessageFiles, {
        owner,
        online: true,
        attachments: [{ ...attachment, filename: "資料.JPG" }],
      }),
      { grant: "seeded" },
    );
    expect(image).toContain("Loading image");
    expect(image).toContain(`src="${grantUrl}"`);
    expect(image).toContain('loading="lazy"');
    expect(image).toContain(`href="${grantUrl}"`);
    expect(image).not.toContain("/preview");
    const unknown = renderEnglish(
      createElement(MessageFiles, {
        owner,
        online: true,
        attachments: [attachment],
      }),
      { grant: "seeded" },
    );
    expect(unknown).not.toContain('aria-haspopup="menu"');
    expect(unknown).not.toContain("Loading image");
    expect(unknown).not.toContain("<img");
  });

  it("uses one lazy video preview as the Play control, even before a grant arrives", async () => {
    const MessageFiles = await files();
    const clip = { ...attachment, filename: "clip.webm" };
    for (const grant of ["seeded", undefined] as const) {
      const withViewer = renderEnglish(
        createElement(MessageFiles, {
          owner,
          online: true,
          attachments: [clip],
        }),
        { viewer: true, ...(grant ? { grant } : {}) },
      );
      expect(withViewer).toContain("Play clip.webm");
      expect(withViewer.match(/aria-label="Play clip.webm"/g)).toHaveLength(1);
      expect(withViewer).toContain('aria-haspopup="dialog"');
      expect(withViewer).toContain(grant ? `href="${grantUrl}"` : 'href="#"');
      if (grant) {
        expect(withViewer).toContain(`src="${grantUrl}/thumbnail"`);
        expect(withViewer).toContain('loading="lazy"');
      }
    }
    const withoutViewer = renderEnglish(
      createElement(MessageFiles, { owner, online: true, attachments: [clip] }),
      { grant: "seeded" },
    );
    expect(withoutViewer).not.toContain("Play clip.webm");
    const document = renderEnglish(
      createElement(MessageFiles, {
        owner,
        online: true,
        attachments: [attachment],
      }),
      { viewer: true, grant: "seeded" },
    );
    expect(document).not.toContain("Play ");
  });

  it("shows a refused grant as an unavailable state with Try again while the row stays", async () => {
    const MessageFiles = await files();
    const document = renderEnglish(
      createElement(MessageFiles, {
        owner,
        online: true,
        attachments: [attachment],
      }),
      { grant: "failed", viewer: true },
    );
    expect(document).toContain("共有資料.txt");
    expect(document).toContain("Download unavailable");
    expect(document).toContain("Try again");
    const image = renderEnglish(
      createElement(MessageFiles, {
        owner,
        online: true,
        attachments: [{ ...attachment, filename: "photo.png" }],
      }),
      { grant: "failed" },
    );
    expect(image).toContain("Image preview unavailable");
    expect(image).toContain("Try again");
    expect(image).not.toContain("<img");
    expect(image).not.toContain("Download unavailable");
  });

  it("keeps offline attachments read-only without downloads, previews or action triggers", async () => {
    const MessageFiles = await files();
    const offline = renderEnglish(
      createElement(MessageFiles, {
        owner,
        attachments: [{ ...attachment, filename: "old-image.PNG" }],
        online: false,
        onRemove: vi.fn(),
      }),
      { grant: "seeded", viewer: true },
    );
    expect(offline).not.toContain("<img");
    expect(offline).not.toContain("/api/files/");
    expect(offline).not.toContain("<button");
    expect(offline).toContain("Reconnect to download");
  });
});
