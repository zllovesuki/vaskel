import type { ReactNode } from "react";

/** Settings align with the room header; each section chooses its content width. */
export const settingsBodyStyles = "min-h-0 flex-1 overflow-auto px-page-gutter";
export const settingsColumnStyles = "flex min-w-0 flex-col pb-10";
/** Settings lists share one idiom: hairline-separated rows, never cards. */
export const settingsListStyles = "flex flex-col divide-y divide-line";
export const settingsRowStyles =
  "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5";

/** A titled block of a settings page, closed by a hairline. */
export function SettingsSection({
  title,
  description,
  width = "form",
  children,
}: {
  title: string;
  description?: string;
  width?: "form" | "full";
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`flex w-full flex-col gap-4 border-b border-line py-6 last:border-b-0 ${width === "form" ? "max-w-[46rem]" : ""}`}
    >
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {/* A reading measure for prose; the lists and forms below keep their widths. */}
        {description && (
          <p className="mt-1 max-w-[70ch] text-caption leading-relaxed text-muted">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}
