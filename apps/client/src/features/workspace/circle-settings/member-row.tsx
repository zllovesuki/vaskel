import type { ReactNode } from "react";
import { Crown, Ellipsis } from "lucide-react";
import type { MemberRole } from "@vaskel/contracts/resources";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { ActionsMenu, type ActionsMenuItem } from "@/client/ui/actions-menu";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { roleMessage } from "./model";
import { Avatar, personHue } from "@vaskel/ui/components/avatar";

/**
 * One person of a circle, the same on the People page and in circle settings:
 * hue monogram with the presence dot, name with the owner's crown, then a
 * caption of presence, "You" and role. The one visible action is the page's
 * primary one; everything the owner decides about the person waits in a menu,
 * and an inline confirmation for an irreversible choice sits under the row.
 */
export function MemberRow({
  member,
  presence,
  name,
  self,
  primary,
  menu,
  confirm,
}: {
  member: { userId: string; role: MemberRole };
  presence: "online" | "offline" | "unknown";
  name: string;
  self: boolean;
  primary?: ReactNode;
  menu?: readonly ActionsMenuItem[] | undefined;
  confirm?: ReactNode;
}) {
  const { t, text } = useI18n();
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="relative shrink-0">
          <Avatar name={name} hue={personHue(member.userId)} />
          {presence === "online" && (
            <span
              className="live-dot absolute -right-0.5 -bottom-0.5 ring-2 ring-surface"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 leading-snug">
          <span className="flex items-center gap-1.5 text-ui font-medium">
            <span className="truncate">{name}</span>
            {member.role === "owner" && (
              <Crown
                className="size-3.5 shrink-0 text-accent"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="block text-caption text-muted">
            {[
              presence === "online" ? t("workspace.online") : null,
              self ? t("workspace.you") : null,
              text(roleMessage(member.role)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {primary}
        {menu && menu.length > 0 && (
          <ActionsMenu
            label={t("workspace.personOptions", { name })}
            buttonClass={buttonStyles({
              variant: "muted",
              size: "icon-small",
            })}
            items={menu}
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </ActionsMenu>
        )}
      </div>
      {confirm}
    </>
  );
}
