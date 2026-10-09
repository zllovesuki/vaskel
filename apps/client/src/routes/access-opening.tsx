import {
  buttonStyles,
  emptyStateStyles,
  formStyles,
} from "@vaskel/ui/components/control-styles";
import { useAccess } from "@/client/features/cache/access/context";
import type { UiMessage } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { isWorkspacePage, useRoutePage } from "./route-page";
import { WorkspaceSkeleton } from "@/client/ui/workspace-skeleton";
import {
  Bone,
  FieldSkeleton,
  Line,
  Placeholder,
} from "@/client/ui/loading-skeleton";

export function AccessOpening({ error }: { error?: UiMessage }) {
  const { retry } = useAccess();
  const { t, text } = useI18n();
  if (isWorkspacePage(useRoutePage()))
    return (
      <WorkspaceSkeleton
        {...(error
          ? { failure: { message: text(error), retry: () => void retry() } }
          : {})}
      />
    );
  if (!error) return <EntryOpening />;
  return (
    <main className={emptyStateStyles}>
      <h1>{t("root.accessFailed")}</h1>
      <p>{text(error)}</p>
      <button className={buttonStyles()} onClick={() => void retry()}>
        {t("common.tryAgain")}
      </button>
    </main>
  );
}

/** The public entry frame while account admission or its view code loads. */
export function EntryOpening() {
  const { t } = useI18n();
  return (
    <main className="flex min-h-svh flex-col bg-page p-6 sm:px-12 sm:py-8">
      <div className="m-auto w-full max-w-[25rem] py-10 sm:py-16">
        <Placeholder label={t("root.opening")} kind="auth">
          <div className="mb-8 min-h-12" />
          <Line size="h1" width="w-32" className="mb-4" />
          <div className={formStyles}>
            {[0, 1].map((field) => (
              <FieldSkeleton key={field} label={<Line width="w-16" />} />
            ))}
            <Bone className="min-h-control-tall w-full pointer-coarse:min-h-control-touch" />
          </div>
          <Line
            size="caption"
            width="w-28"
            className="mt-4 min-h-control-normal"
          />
        </Placeholder>
      </div>
    </main>
  );
}
