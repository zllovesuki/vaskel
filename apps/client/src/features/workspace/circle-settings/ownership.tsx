import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { resourceLocation } from "@/client/routes/resource-location";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ConfirmRow } from "@/client/ui/confirm-row";
import { FieldSkeleton, Placeholder } from "@/client/ui/loading-skeleton";
import {
  buttonRowStyles,
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  formStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";
import type { CircleResource, MemberState, PeopleState } from "./types";
import { useCommands } from "./commands";
import { Failure } from "@/client/ui/failure";

export function Transfer({
  resource,
  members,
  people,
}: {
  resource: CircleResource;
  members: MemberState;
  people: PeopleState;
}) {
  const { t } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const { run, busy } = useCommands();
  const navigate = useNavigate();
  const [userId, setUserId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const transfer = useMutation({
    mutationFn: () =>
      run({
        action: "transfer",
        body: { userId, expectedVersion: resource.version },
      }),
    onSuccess: async () => {
      // The viewer is a member now; settings are no longer theirs to open.
      await navigate({
        ...resourceLocation(resource.owner),
        search: {},
      });
    },
  });
  const candidates = (members.data?.members ?? []).filter(
    (member) => member.userId !== user.userId,
  );
  const chosen = candidates.find((member) => member.userId === userId);
  // Ownership passes to a person, not to an account id: without their names
  // this choice cannot be made, so it waits for them.
  const named = !people.loading && !people.failed;
  const blocked = !canUseNetwork || busy || !named;
  const personName = (id: string) => people.names.get(id) ?? t("chat.member");
  if (members.loading || people.loading)
    return (
      <Placeholder
        label={t("workspace.loadingPeople")}
        kind="form"
        className={formStyles}
      >
        <FieldSkeleton label={t("workspace.chooseNewOwner")} />
        <div className={buttonRowStyles}>
          <button
            type="button"
            className={buttonStyles({ variant: "danger", size: "small" })}
            disabled
          >
            {t("workspace.transferOwnership")}
          </button>
        </div>
      </Placeholder>
    );
  return (
    <>
      <label className={labelStyles}>
        {t("workspace.chooseNewOwner")}
        <select
          className={fieldStyles}
          value={userId}
          disabled={blocked}
          onChange={(event) => {
            setUserId(event.target.value);
            setConfirming(false);
          }}
        >
          <option value="">{t("workspace.choosePerson")}</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {personName(member.userId)}
            </option>
          ))}
        </select>
        {people.failed && (
          <span role="status" className={fieldHintStyles}>
            {t("workspace.peopleUnavailable")}
          </span>
        )}
      </label>
      {/* While the question is open, it holds the only Transfer ownership. */}
      <div className={buttonRowStyles} hidden={confirming && Boolean(chosen)}>
        <button
          ref={trigger}
          type="button"
          className={buttonStyles({ variant: "danger", size: "small" })}
          disabled={blocked || !chosen}
          onClick={() => setConfirming(true)}
        >
          {t("workspace.transferOwnership")}
        </button>
      </div>
      {confirming && chosen && (
        <ConfirmRow
          question={t("workspace.transferConfirm", {
            name: personName(chosen.userId),
          })}
          confirmLabel={t("workspace.transferOwnership")}
          busyLabel={t("workspace.transferring")}
          busy={transfer.isPending}
          disabled={!canUseNetwork || !named}
          returnFocus={trigger}
          onConfirm={() => transfer.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
      <Failure error={transfer.error} />
    </>
  );
}
