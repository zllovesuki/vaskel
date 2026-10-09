import type { ElementProps } from "@vaskel/ui/components/element";

/**
 * Where the app has links, the preview switches rooms in place. A button
 * sizes to its content where a link would fill its row, hence `w-full`.
 */
export const opens = (go: () => void) => (props: ElementProps) => (
  <button
    type="button"
    {...props}
    className={`${props.className} w-full text-left`}
    onClick={go}
  />
);

/** Places the app offers but the preview does not open. */
export const still = (props: ElementProps) => <span {...props} inert />;
