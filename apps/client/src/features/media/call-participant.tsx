import {
  Ellipsis,
  HeadphoneOff,
  LogOut,
  Mic,
  MicOff,
  ScreenShare,
} from "lucide-react";
import type { MediaSnapshot } from "@vaskel/contracts/media";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { personHue } from "@vaskel/ui/components/avatar";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { ParticipantChip } from "@vaskel/ui/components/call";
import { ActionsMenu } from "@/client/ui/actions-menu";
import { useMedia } from "./context";
import { useSpeaking } from "./call-hooks";

type MediaParticipant = MediaSnapshot["participants"][number];

/** A person at the table, and moderation for owners. */
export function CallParticipant({
  participant,
  name,
}: {
  participant: MediaParticipant;
  name: string;
}) {
  const { t } = useI18n();
  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  const session = state.session;
  const own = participant.id === session?.participantId;
  const stream = own
    ? session?.local.find((item) => item.source === "microphone")?.stream
    : session?.remote.find(
        (item) =>
          item.publication.participantId === participant.id &&
          item.publication.source === "microphone",
      )?.stream;
  const speaking = useSpeaking(participant.muted ? null : stream);
  const leaving = participant.status === "closing";
  return (
    <ParticipantChip
      name={name}
      hue={personHue(participant.userId)}
      speaking={speaking}
      muted={participant.muted}
      deafened={participant.deafened}
      leaving={leaving}
      status={
        participant.deafened
          ? t("media.deafened")
          : participant.muted
            ? t("media.mutedByOwner")
            : leaving
              ? t("media.leaving")
              : speaking
                ? t("media.speaking")
                : t("media.inCall")
      }
    >
      {state.canModerate && !own && (
        <ActionsMenu
          label={t("media.managePerson", { name })}
          buttonClass={buttonStyles({
            variant: "stage-muted",
            size: "icon-small",
            shape: "round",
          })}
          items={[
            {
              id: "mute",
              label: participant.muted
                ? t("media.allowMicrophone")
                : t("media.mute"),
              icon: participant.muted ? (
                <Mic className="size-4 text-muted" aria-hidden="true" />
              ) : (
                <MicOff className="size-4 text-muted" aria-hidden="true" />
              ),
              disabled: !canUseNetwork,
              onSelect: () =>
                void controller.moderate(
                  participant,
                  "mute",
                  !participant.muted,
                ),
            },
            {
              id: "deafen",
              label: participant.deafened
                ? t("media.allowListening")
                : t("media.deafen"),
              icon: (
                <HeadphoneOff
                  className="size-4 text-muted"
                  aria-hidden="true"
                />
              ),
              disabled: !canUseNetwork,
              onSelect: () =>
                void controller.moderate(
                  participant,
                  "deafen",
                  !participant.deafened,
                ),
            },
            {
              id: "screen",
              label: participant.screenRevoked
                ? t("media.allowScreenSharing")
                : t("media.stopScreenSharing"),
              icon: (
                <ScreenShare className="size-4 text-muted" aria-hidden="true" />
              ),
              disabled: !canUseNetwork,
              onSelect: () =>
                void controller.moderate(
                  participant,
                  "screen_revoke",
                  !participant.screenRevoked,
                ),
            },
            {
              id: "remove",
              label: t("media.removeFromCall"),
              icon: <LogOut className="size-4" aria-hidden="true" />,
              destructive: true,
              disabled: !canUseNetwork,
              onSelect: () =>
                void controller.moderate(participant, "remove", true),
            },
          ]}
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </ActionsMenu>
      )}
    </ParticipantChip>
  );
}
