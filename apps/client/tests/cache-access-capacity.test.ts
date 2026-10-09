import {
  assertKind,
  failureResponse,
  fetchRequest,
  resourcePath,
} from "@tests/helpers/http";
import { QueryClient } from "@tanstack/react-query";
import {
  MessagingOutcomeSchema,
  type SendMessage,
} from "@vaskel/contracts/messaging";
import { UploadController } from "@/client/features/files/upload-controller";
import { message } from "@/client/features/i18n/messages";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  api,
  user,
  owner,
  selected,
  fixture,
  authenticated,
  loadAccessModules,
} from "@tests/helpers/cache-access";

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  await loadAccessModules();
});
afterAll(() => vi.unstubAllGlobals());

describe("storage capacity rejection", () => {
  it("keeps authenticated Query/history access and retained files after a definite rejected send", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const { uploadTransport } =
      await import("@/client/features/files/transport");
    const { isDefiniteSendRejection, handleTimelineMutationFailure } =
      await import("@/client/features/chat/mutation-failure");
    const client = new QueryClient({
      defaultOptions: { mutations: { networkMode: "always", retry: false } },
    });
    const key = [
      ...api.privateKey(user.userId),
      "timeline",
      owner.kind,
      owner.id,
    ];
    const history = { messages: [{ body: "Retained history" }] };
    client.setQueryData(key, history);
    const state = access.getSnapshot();
    const token = access.ownerToken(owner);
    const file = new File(["retained content"], "notes.txt");
    const fileId = crypto.randomUUID();
    const attachment = { fileId, filename: file.name, byteLength: file.size };
    const fetcher = vi.fn(async (path: RequestInfo | URL) => {
      if (new URL(fetchRequest(path).url).pathname.endsWith("/reserve"))
        return Response.json({
          kind: "attachment_reserved",
          fileId,
          expiresAt: 100,
        });
      if (new URL(fetchRequest(path).url).pathname.endsWith("/content"))
        return Response.json({
          kind: "attachment_ready",
          attachment,
          expiresAt: 100,
        });
      if (new URL(fetchRequest(path).url).pathname.endsWith("/cancel"))
        return Response.json({ kind: "attachment_canceled" });
      return failureResponse({ kind: "storage_capacity" }, { status: 429 });
    });
    vi.stubGlobal("fetch", fetcher);
    const removeAccess = api.installRequestAccess(access.transport);
    const uploads = new UploadController(
      uploadTransport(owner, selected.channelId),
    );
    const deny = vi.fn();
    const reconcile = vi.fn();
    try {
      uploads.select([file]);
      await vi.waitFor(() =>
        expect(uploads.getSnapshot()[0]?.phase).toBe("ready"),
      );
      const draft: SendMessage = {
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
        channelId: selected.channelId,
        body: "Keep this draft",
        attachmentIds: uploads.freeze(),
      };
      const mutation = client.getMutationCache().build(client, {
        mutationFn: async (command: SendMessage) =>
          assertKind(
            await api.requestWithInit(
              `${resourcePath(owner)}/send`,
              MessagingOutcomeSchema,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(command),
              },
              { authority: "resource", owner: owner },
            ),
            "accepted",
          ),
        onError: (error) =>
          handleTimelineMutationFailure(error, {
            client,
            userId: user.userId,
            deny,
            reconcile,
          }),
      });
      await expect(mutation.execute(draft)).rejects.toMatchObject({
        code: "storage_capacity",
      });
      expect(isDefiniteSendRejection(mutation.state.error)).toBe(true);
      expect(isDefiniteSendRejection(new api.NetworkError())).toBe(false);
      expect(
        isDefiniteSendRejection(
          new api.ApiError("storage_capacity", 200, "contract"),
        ),
      ).toBe(false);
      expect(api.errorMessage(mutation.state.error)).toEqual(
        message("api.storageCapacity"),
      );
      expect(mutation.state.variables).toEqual(draft);
      uploads.unlock();
      expect(uploads.getSnapshot()[0]?.file).toBe(file);
      expect(uploads.getSnapshot()[0]?.phase).toBe("ready");
      expect(
        fetcher.mock.calls.filter(([path]) =>
          new URL(fetchRequest(path).url).pathname.endsWith("/send"),
        ),
      ).toHaveLength(1);
      expect(access.getSnapshot()).toBe(state);
      expect(access.ownerToken(owner)).toBe(token);
      expect(client.getQueryData(key)).toEqual(history);
      expect(deny).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(cache.invalidateOwner).not.toHaveBeenCalled();
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      // Storage admission rejection does not prevent canceling an admitted file.
      uploads.remove(uploads.getSnapshot()[0]!.id);
      await vi.waitFor(() =>
        expect(
          fetcher.mock.calls.some(([path]) =>
            new URL(fetchRequest(path).url).pathname.endsWith("/cancel"),
          ),
        ).toBe(true),
      );
    } finally {
      uploads.dispose();
      removeAccess();
      client.clear();
      access.stop();
    }
  });

  it("retains a reservation-rejected File without upload or background retry until explicit retry", async () => {
    const { access, cache, dependencies } = fixture();
    await authenticated(access);
    const { uploadTransport } =
      await import("@/client/features/files/transport");
    const file = new File(["keep selected bytes"], "notes.txt");
    const fileId = crypto.randomUUID();
    const attachment = { fileId, filename: file.name, byteLength: file.size };
    let allowReservation = false;
    const fetcher = vi.fn(
      async (path: RequestInfo | URL, _init: RequestInit) => {
        if (new URL(fetchRequest(path).url).pathname.endsWith("/reserve"))
          return allowReservation
            ? Response.json({
                kind: "attachment_reserved",
                fileId,
                expiresAt: 100,
              })
            : failureResponse({ kind: "storage_capacity" }, { status: 429 });
        return Response.json({
          kind: "attachment_ready",
          attachment,
          expiresAt: 100,
        });
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const removeAccess = api.installRequestAccess(access.transport);
    const uploads = new UploadController(
      uploadTransport(owner, selected.channelId),
    );
    const state = access.getSnapshot();
    try {
      uploads.select([file]);
      await vi.waitFor(() =>
        expect(uploads.getSnapshot()[0]?.phase).toBe("error"),
      );
      const rejected = uploads.getSnapshot()[0]!;
      expect(rejected.file).toBe(file);
      expect(rejected.fileId).toBeUndefined();
      expect(rejected.attachment).toBeUndefined();
      expect(rejected.error).toEqual(message("api.storageCapacity"));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(access.getSnapshot()).toBe(state);
      expect(cache.invalidateAccount).not.toHaveBeenCalled();
      expect(dependencies.closeAccount).not.toHaveBeenCalled();
      allowReservation = true;
      uploads.setOnline(true);
      expect(fetcher).toHaveBeenCalledOnce();
      await uploads.retry(rejected.id);
      expect(fetcher.mock.calls[1]![1].body).toBe(
        fetcher.mock.calls[0]![1].body,
      );
      expect(uploads.getSnapshot()[0]?.phase).toBe("ready");
      expect(uploads.getSnapshot()[0]?.file).toBe(file);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      uploads.dispose();
      removeAccess();
      access.stop();
    }
  });
});
