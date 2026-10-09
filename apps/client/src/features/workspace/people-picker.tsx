import { ChevronRight, Ellipsis } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/client/api/contract";
import { privateKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { PersonBlockControl } from "@/client/features/blocking/block-control";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useStartConversation } from "./start-conversation";
import { PeopleSkeleton } from "@/client/ui/loading-skeleton";
import { Failure } from "@/client/ui/failure";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";
import {
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  formStyles,
  labelStyles,
  washStyles,
} from "@vaskel/ui/components/control-styles";

export function PeoplePicker({ close }: { close: () => void }) {
  const { t } = useI18n();
  const { canUseNetwork } = useAccess();
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const user = useUser();
  const people = useQuery({
    queryKey: [...privateKey(user.userId), "people-search", deferred],
    queryFn: ({ signal }) =>
      api.people({ query: { query: deferred } }, { signal: signal }),
    enabled: canUseNetwork && deferred.length > 0,
    retry: false,
  });
  const start = useStartConversation(close);
  return (
    <div className={formStyles}>
      <label className={labelStyles}>
        {t("workspace.findPerson")}
        <input
          className={fieldStyles}
          value={query}
          disabled={!canUseNetwork}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={80}
          data-autofocus
          placeholder={t("workspace.displayNamePlaceholder")}
        />
      </label>
      {people.isFetching && !people.data && (
        <PeopleSkeleton
          label={t("workspace.searching")}
          lines={1}
          rowClassName="min-h-11 p-1.5"
        />
      )}
      <Failure error={people.error} />
      <Failure error={start.error} />
      <div className="flex max-h-80 flex-col gap-1 overflow-auto">
        {people.data?.people
          .filter((person) => person.userId !== user.userId)
          .map((person) => (
            <div key={person.userId}>
              <div className="flex items-center gap-2">
                <button
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg border-0 bg-transparent p-1.5 text-left ${washStyles}`}
                  disabled={!canUseNetwork || start.isPending}
                  onClick={() => start.mutate(person.userId)}
                >
                  <Avatar
                    name={person.displayName}
                    hue={personHue(person.userId)}
                  />
                  <span className="min-w-0 flex-1 wrap-anywhere">
                    {person.displayName}
                  </span>
                  <ChevronRight
                    className="size-4 text-muted"
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  className={buttonStyles({ variant: "quiet", size: "icon" })}
                  aria-label={t("workspace.personOptions", {
                    name: person.displayName,
                  })}
                  aria-expanded={selectedPerson === person.userId}
                  onClick={() =>
                    setSelectedPerson(
                      selectedPerson === person.userId ? null : person.userId,
                    )
                  }
                >
                  <Ellipsis aria-hidden="true" />
                </button>
              </div>
              {selectedPerson === person.userId && (
                <div className="border-b border-line px-2 pb-3">
                  <p className="mb-2 text-caption text-muted">
                    {t("workspace.blockHint")}
                  </p>
                  <PersonBlockControl
                    targetId={person.userId}
                    name={person.displayName}
                  />
                </div>
              )}
            </div>
          ))}
      </div>
      {people.data &&
        people.data.people.filter((person) => person.userId !== user.userId)
          .length === 0 && (
          <p className="text-muted">{t("workspace.noPeople")}</p>
        )}
      {people.data?.partial && (
        <p role="status" className={fieldHintStyles}>
          {t("workspace.peoplePartial")}
        </p>
      )}
    </div>
  );
}
