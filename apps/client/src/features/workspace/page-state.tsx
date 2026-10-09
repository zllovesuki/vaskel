import { NavigationToggle } from "@vaskel/ui/components/home";
import {
  buttonRowStyles,
  buttonStyles,
  chatHeaderStyles,
  emptyStateStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import { errorMessage } from "@/client/api/client";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { DialogButton } from "@/client/ui/dialog";
import { Unavailable } from "@/client/ui/failure";
import { Line } from "@/client/ui/loading-skeleton";
import {
  ComposerSkeleton,
  TimelineSkeleton,
  timelineSkeletonFrameStyles,
} from "@/client/ui/workspace-skeleton";
import { JoinForm } from "./join-form";
import { NewServerForm } from "./new-server-form";
import { PeoplePicker } from "./people-picker";
import { useWorkspace } from "./context";
import type { PageState } from "./destination";

function PageHeader({ pending = false }: { pending?: boolean }) {
  const { t } = useI18n();
  const { openNavigation } = useWorkspace();
  return (
    <header className={chatHeaderStyles}>
      <NavigationToggle
        action="open"
        label={t("workspace.openConversations")}
        onClick={openNavigation}
      />
      {pending ? (
        <Line width="w-36" />
      ) : (
        <span className="text-ui text-muted">
          {t("workspace.conversations")}
        </span>
      )}
    </header>
  );
}

/** Only the destination waits; navigation and account controls remain available. */
export function WorkspacePending() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader pending />
      <div role="status" className={timelineSkeletonFrameStyles}>
        <span className="sr-only">{t("workspace.loadingConversations")}</span>
        <TimelineSkeleton />
      </div>
      <ComposerSkeleton />
    </>
  );
}

export function WorkspacePageState({ state }: { state: PageState }) {
  const { t, text } = useI18n();
  const access = useAccess();
  const {
    navigation: { canCreate },
  } = useWorkspace();
  if (state.kind === "loading") return <WorkspacePending />;
  const unavailable = state.kind === "unavailable";
  return (
    <>
      <PageHeader />
      <div className={emptyStateStyles}>
        {state.kind === "error" ? (
          <Unavailable
            message={text(errorMessage(state.error))}
            onRetry={() => void state.retry()}
            disabled={!access.canUseNetwork}
          />
        ) : (
          <>
            <h1 className="text-[1.6rem]">
              {unavailable
                ? t("workspace.unavailableTitle")
                : t("workspace.chooseConversation")}
            </h1>
            <p className="text-muted">
              {unavailable
                ? t("workspace.unavailableDescription")
                : t("workspace.emptyDescription")}
            </p>
            <div className={`${buttonRowStyles} mt-2 justify-center`}>
              <DialogButton
                label={t("workspace.joinServer")}
                buttonClass={buttonStyles({ variant: "primary" })}
                title={t("workspace.joinServer")}
                description={t("workspace.circleExplainer")}
              >
                {(close) => <JoinForm close={close} />}
              </DialogButton>
              <DialogButton
                label={t("workspace.messageSomeone")}
                buttonClass={buttonStyles()}
                title={t("workspace.startConversation")}
              >
                {(close) => <PeoplePicker close={close} />}
              </DialogButton>
            </div>
            {canCreate && (
              <DialogButton
                label={t("workspace.createServer")}
                buttonClass={textButtonStyles()}
                title={t("workspace.createServer")}
                description={t("workspace.circleExplainer")}
              >
                {(close) => <NewServerForm close={close} />}
              </DialogButton>
            )}
          </>
        )}
      </div>
    </>
  );
}
