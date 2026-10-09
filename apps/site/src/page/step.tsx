import type { ReactNode } from "react";

type Props = {
  id: string;
  number: number;
  title: string;
  lede?: string;
  aside?: ReactNode;
  hero?: boolean;
  children: ReactNode;
};

/** One numbered step of the install file; the numbers are the sequence a host follows. */
export function Step({
  id,
  number,
  title,
  lede,
  aside,
  hero,
  children,
}: Props) {
  return (
    <section
      className={`wrap border-b border-line pb-16 last-of-type:border-0 max-sm:pb-11 ${hero ? "pt-4" : "pt-14 max-sm:pt-10"}`}
      id={id}
      aria-labelledby={`${id}-title`}
    >
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-10 gap-y-4 max-lg:grid-cols-1 max-lg:items-start ${hero ? "mb-3 items-center" : "mb-7 items-end"}`}
      >
        <div>
          <h2
            className="text-[clamp(2rem,1.2rem_+_2.6vw,3rem)] leading-[1.08] font-bold tracking-[-0.03em] text-balance"
            id={`${id}-title`}
          >
            <span className="font-semibold text-muted tabular-nums">
              {number} ·
            </span>{" "}
            {title}
          </h2>
          {lede && (
            <p className="mt-3 max-w-[40rem] text-chat text-pretty text-muted">
              {lede}
            </p>
          )}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
