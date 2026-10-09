import { useI18n } from "@/client/features/i18n/use-i18n";
import { Bone, Line } from "@/client/ui/loading-skeleton";
import {
  buttonStyles,
  chatHeaderStyles,
  emptyStateStyles,
  sidebarBodyStyles,
  workspaceGridStyles,
  workspaceMainStyles,
  workspaceSidebarStyles,
} from "@vaskel/ui/components/control-styles";
import {
  composerFrameStyles,
  composerSurfaceStyles,
  composerInputStyles,
  composerToolbarStyles,
} from "@vaskel/ui/components/room";
import { HomeHeader, Wordmark } from "@vaskel/ui/components/home";

/** Bottom-anchored like the timeline's scroll area, with its padding. */
export const timelineSkeletonFrameStyles =
  "flex min-h-0 flex-1 flex-col justify-end px-page-gutter pt-2 pb-3";

/**
 * The rows shown where messages will appear, anchored to the bottom like the timeline,
 * fading upward into history; the chat panel shows the same ones.
 */
export function TimelineSkeleton() {
  return (
    <div className="mt-2.5" aria-hidden="true" data-skeleton="timeline">
      <div className="message-heading opacity-40">
        <span className="relative">
          <Bone className="absolute top-0 left-0 size-9 rounded-[30%]" />
        </span>
        <Line width="w-28" />
      </div>
      {["w-[40%]", "w-[70%]", "w-[55%]"].map((width, index) => (
        <div
          key={index}
          className="message-line"
          style={{ opacity: 0.5 + index * 0.25 }}
        >
          <span />
          <div>
            <Line size="chat" className="leading-relaxed" width={width} />
            <span className="block h-px" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Startup, conversation loading and draft restoration reserve the same composer. */
export function ComposerSkeleton() {
  return (
    <div
      className={composerFrameStyles}
      aria-hidden="true"
      data-skeleton="composer"
    >
      <div className={`${composerSurfaceStyles} bg-subtle`}>
        <div className={composerInputStyles} />
        <div className={composerToolbarStyles} />
      </div>
    </div>
  );
}

/** Home rows: a mark beside a name, under an optional section label. */
export function SidebarRows({
  label,
  rows,
  round = false,
}: {
  /** Width class of the section label's bone; omitted where the real label stays. */
  label?: string;
  rows: readonly string[];
  round?: boolean;
}) {
  return (
    <div className="not-first:mt-4">
      {label && (
        <div className="mb-1 flex min-h-7 items-center px-2.5">
          <span className={`bone h-2.5 rounded-full ${label}`} />
        </div>
      )}
      {rows.map((width, index) => (
        <div
          key={index}
          className="flex min-h-control-normal items-center gap-2.5 px-2.5"
        >
          <Bone
            className={`size-6 ${round ? "rounded-[30%]" : "rounded-md"}`}
          />
          <Line width={width} />
        </div>
      ))}
    </div>
  );
}

/**
 * The workspace's own frame with nothing in it yet: Home beside the conversation on wide
 * screens, the conversation alone on phones. It covers account admission and initial code
 * loading and, with `failure`, presents account recovery in the same frame.
 */
export function WorkspaceSkeleton({
  fill = false,
  failure,
}: {
  /** Inside the media provider's column (`h-full`) rather than filling the viewport. */
  fill?: boolean;
  failure?: { message: string; retry: () => void };
}) {
  const { t } = useI18n();
  return (
    <div className={`${workspaceGridStyles} ${fill ? "h-full" : "h-dvh"}`}>
      <div
        className={workspaceSidebarStyles}
        aria-hidden="true"
        data-skeleton="sidebar"
      >
        <HomeHeader
          wordmark={<Wordmark render={(props) => <p {...props} />} />}
          add={<Bone className="size-target" />}
          account={<Bone className="size-target rounded-full" />}
        />
        <div className={sidebarBodyStyles}>
          <div className="mb-3 flex min-h-control-normal items-center gap-2.5 px-2.5">
            <Bone className="size-4 rounded-sm" />
            <Line width="w-28" />
          </div>
          <SidebarRows label="w-20" rows={["w-[60%]", "w-[45%]", "w-[55%]"]} />
          <SidebarRows label="w-28" rows={["w-[40%]", "w-[50%]"]} round />
        </div>
      </div>
      <div className={workspaceMainStyles}>
        <div
          className={chatHeaderStyles}
          aria-hidden="true"
          data-skeleton="header"
        >
          <Bone className="size-target shrink-0 sm:hidden" />
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-initial sm:gap-2.5">
            <span className="bone hidden size-8 shrink-0 rounded-[30%] sm:block" />
            <div className="min-w-0">
              <h1 className="flex h-[1lh] items-center text-chat font-semibold sm:text-base">
                <span className="bone h-[0.7em] w-36 rounded-full" />
              </h1>
              <Line size="caption" width="w-48" />
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            <Bone className="size-target" />
            <Bone className="size-target" />
          </div>
        </div>
        {failure ? (
          <div className={emptyStateStyles}>
            <h1 className="text-[1.6rem]">{t("root.accessFailed")}</h1>
            <p className="text-muted" role="alert">
              {failure.message}
            </p>
            <button className={buttonStyles()} onClick={failure.retry}>
              {t("common.tryAgain")}
            </button>
          </div>
        ) : (
          <>
            <div className={timelineSkeletonFrameStyles} aria-hidden="true">
              <TimelineSkeleton />
            </div>
            <ComposerSkeleton />
          </>
        )}
      </div>
    </div>
  );
}
