import { useAppForm } from "@/client/ui/forms/use-app-form";
import { Bone, Line, Placeholder } from "@/client/ui/loading-skeleton";
import { Form } from "@/client/ui/forms/controls";
import { useStore } from "@tanstack/react-form";
import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Hash, Lock, Volume2 } from "lucide-react";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { reorder } from "@/client/features/workspace/circle-settings/model";
import {
  buttonRowStyles,
  buttonStyles,
  fieldHintStyles,
} from "@vaskel/ui/components/control-styles";
import { settingsListStyles } from "@/client/ui/settings-section";
import type { CircleResource, Room, MemberState, PeopleState } from "./types";
import { useCommands } from "./commands";
import { Failure } from "@/client/ui/failure";

export function Rooms({
  resource,
  members,
  people,
}: {
  resource: CircleResource;
  members: MemberState;
  people: PeopleState;
}) {
  const [moved, setMoved] = useState("");
  // A saved room remounts with its confirmed values; its Edit button takes the
  // focus back once the fresh row exists, so a keyboard reader is not dropped.
  const [refocus, setRefocus] = useState<string | null>(null);
  return (
    <>
      <ul className={settingsListStyles}>
        {resource.channels.map((room, index) => (
          // The confirmed name and topic reset the fields; a version bump alone,
          // such as another room moving, leaves an unfinished edit in place.
          <RoomRow
            key={`${room.id}:${room.name}:${room.topic ?? ""}`}
            resource={resource}
            room={room}
            index={index}
            members={members}
            people={people}
            announce={setMoved}
            refocus={refocus === room.id}
            requestRefocus={setRefocus}
          />
        ))}
      </ul>
      {/* A moved room keeps the focus on its arrow, so only this speaks. */}
      <p role="status" className="sr-only">
        {moved}
      </p>
    </>
  );
}

function RoomRow({
  resource,
  room,
  index,
  members,
  people,
  announce,
  refocus,
  requestRefocus,
}: {
  resource: CircleResource;
  room: Room;
  index: number;
  members: MemberState;
  people: PeopleState;
  announce: (message: string) => void;
  refocus: boolean;
  requestRefocus: (roomId: string | null) => void;
}) {
  const { t, formatNumber } = useI18n();
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCommands();
  const rooms = resource.channels;
  const nameId = useId();
  const editorId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const form = useAppForm({
    defaultValues: { name: room.name, topic: room.topic ?? "" },
    onSubmit: submit,
  });
  const { name, topic } = useStore(form.store, (state) => state.values);
  const nextName = name.trim();
  const nextTopic = topic.trim();
  const renamed = nextName !== room.name;
  const retopiced = nextTopic !== (room.topic ?? "");
  const save = useMutation({
    mutationFn: () =>
      run({
        action: "update-channel",
        body: {
          channelId: room.id,
          ...(renamed ? { name: nextName } : {}),
          ...(retopiced ? { topic: nextTopic === "" ? null : nextTopic } : {}),
          expectedVersion: room.version,
        },
      }),
  });
  const move = useMutation({
    mutationFn: async (to: number) => {
      await run({
        action: "reorder-channels",
        body: {
          channelIds: reorder(rooms, index, to).map((room) => room.id),
          expectedVersion: resource.version,
        },
      });
      announce(
        t("workspace.roomMoved", {
          name: room.name,
          position: formatNumber(to + 1),
          total: formatNumber(rooms.length),
        }),
      );
    },
  });
  useEffect(() => {
    if (open) nameField.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!refocus) return;
    editButton.current?.focus();
    requestRefocus(null);
  }, [refocus, requestRefocus]);
  const blocked = !canUseNetwork || busy;
  // The arrows stay operable so the pressed one keeps its focus while the list
  // settles; a press with nowhere to go, or during a command, does nothing.
  const step = (to: number) => {
    if (blocked || to < 0 || to >= rooms.length) return;
    move.mutate(to);
  };
  function cancel() {
    form.reset();
    save.reset();
    setOpen(false);
    editButton.current?.focus();
  }
  async function submit() {
    try {
      await save.mutateAsync();
    } catch {
      // The failure stays on the open editor through `save.error`.
      return;
    }
    // The confirmed values remount this row closed; hand the focus to its Edit.
    requestRefocus(room.id);
  }
  const Icon = room.kind === "media" ? Volume2 : room.private ? Lock : Hash;
  return (
    <li className="py-1.5">
      <div className="flex min-h-target items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
        {/* The name is what a row is for: on a phone the topic drops to its own
            line, and from `sm` up the topic gives way first. */}
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
          <span
            id={nameId}
            className="min-w-0 truncate text-ui font-medium sm:max-w-[60%] sm:shrink-0"
          >
            {room.name}
          </span>
          {room.topic && (
            <span className="min-w-0 truncate text-caption text-muted">
              {room.topic}
            </span>
          )}
        </span>
        <button
          type="button"
          className={buttonStyles({
            variant: "quiet",
            size: "icon-small",
            className: "aria-disabled:opacity-40",
          })}
          aria-disabled={blocked || index === 0}
          aria-label={t("workspace.moveRoomUp", { name: room.name })}
          onClick={() => step(index - 1)}
        >
          <ChevronUp className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={buttonStyles({
            variant: "quiet",
            size: "icon-small",
            className: "aria-disabled:opacity-40",
          })}
          aria-disabled={blocked || index === rooms.length - 1}
          aria-label={t("workspace.moveRoomDown", { name: room.name })}
          onClick={() => step(index + 1)}
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </button>
        <button
          ref={editButton}
          type="button"
          className={buttonStyles({ variant: "quiet", size: "small" })}
          aria-expanded={open}
          aria-controls={editorId}
          aria-describedby={nameId}
          onClick={() => (open ? cancel() : setOpen(true))}
        >
          {t("workspace.editRoom")}
        </button>
      </div>
      {open && (
        <div
          id={editorId}
          role="group"
          aria-labelledby={nameId}
          className="mt-1 mb-2 flex flex-col gap-3 rounded-lg bg-subtle p-3 sm:ml-7"
        >
          <Form className="flex max-w-[46rem] flex-col gap-3" form={form}>
            <div className="grid gap-3 sm:grid-cols-2">
              <form.AppField name="name">
                {(field) => (
                  <field.TextField
                    label={t("workspace.channelName")}
                    ref={nameField}
                    maxLength={100}
                    required
                    disabled={save.isPending}
                  />
                )}
              </form.AppField>
              <form.AppField name="topic">
                {(field) => (
                  <field.TextField
                    label={t("workspace.roomTopic")}
                    maxLength={200}
                    disabled={save.isPending}
                    hint={t("workspace.topicHint")}
                  />
                )}
              </form.AppField>
            </div>
            <div className={buttonRowStyles}>
              <button
                className={buttonStyles({ variant: "primary", size: "small" })}
                disabled={blocked || !nextName || !(renamed || retopiced)}
              >
                {save.isPending ? t("workspace.saving") : t("workspace.save")}
              </button>
              <button
                type="button"
                className={buttonStyles({ variant: "quiet", size: "small" })}
                disabled={save.isPending}
                onClick={cancel}
              >
                {t("chat.cancel")}
              </button>
            </div>
            <Failure error={save.error} />
          </Form>
          {room.private && (
            <RoomPeople room={room} members={members} people={people} />
          )}
        </div>
      )}
      {/* A failed move belongs to the row, whether or not its editor is open. */}
      <Failure error={move.error} />
    </li>
  );
}

/** Who can open one private room, from the owner-authorized members list. */
function RoomPeople({
  room,
  members,
  people,
}: {
  room: Room;
  members: MemberState;
  people: PeopleState;
}) {
  const { t } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCommands();
  const allowed = new Set(
    members.data?.channelMembers.find((entry) => entry.channelId === room.id)
      ?.userIds ?? [],
  );
  const change = useMutation({
    mutationFn: (variables: { userId: string; allowed: boolean }) =>
      run({
        action: "channel-member",
        body: {
          channelId: room.id,
          userId: variables.userId,
          allowed: variables.allowed,
          expectedVersion: room.version,
        },
      }),
  });
  return (
    <fieldset className="border-t border-line pt-3">
      <legend className="text-ui font-medium">
        {t("workspace.roomPeople")}
      </legend>
      <p className={fieldHintStyles}>{t("workspace.roomPeopleHint")}</p>
      {members.data ? (
        <div className="mt-2 flex flex-col gap-1">
          {members.data.members.map((member) => {
            const self = member.userId === user.userId;
            return (
              <label
                key={member.userId}
                className="flex min-h-control-normal cursor-pointer items-center gap-2.5 text-ui"
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={allowed.has(member.userId)}
                  disabled={!canUseNetwork || busy}
                  onChange={(event) =>
                    change.mutate({
                      userId: member.userId,
                      allowed: event.target.checked,
                    })
                  }
                />
                <span className="min-w-0 truncate">
                  {people.names.get(member.userId) ?? t("chat.member")}
                </span>
                {self && (
                  <span className="text-caption text-muted">
                    {t("workspace.you")}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      ) : members.failed ? (
        // An empty list would read as "nobody can open this room".
        <p role="status" className={`${fieldHintStyles} mt-2`}>
          {t("workspace.peopleUnavailable")}
        </p>
      ) : (
        <Placeholder
          label={t("workspace.loadingPeople")}
          kind="people"
          className="mt-2 flex flex-col gap-1"
        >
          {["w-28", "w-20", "w-32"].map((width) => (
            <div
              key={width}
              className="flex min-h-control-normal items-center gap-2.5"
            >
              <Bone className="size-4 rounded-sm" />
              <Line width={width} />
            </div>
          ))}
        </Placeholder>
      )}
      <Failure error={change.error} />
    </fieldset>
  );
}
