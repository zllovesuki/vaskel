import type { ComponentProps, ReactNode } from "react";
import {
  fieldHintStyles,
  fieldStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";
import { useFieldContext } from "./context";

type Label = { label: ReactNode; hint?: ReactNode };

export function TextField({
  label,
  hint,
  ...props
}: Label &
  Omit<
    ComponentProps<"input">,
    "value" | "defaultValue" | "onChange" | "onBlur" | "name"
  >) {
  const field = useFieldContext<string>();
  return (
    <label className={labelStyles}>
      {label}
      <input
        className={fieldStyles}
        {...props}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      />
      {hint && <span className={fieldHintStyles}>{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  hint,
  children,
  ...props
}: Label &
  Omit<
    ComponentProps<"select">,
    "value" | "defaultValue" | "onChange" | "onBlur" | "name"
  >) {
  const field = useFieldContext<string>();
  return (
    <label className={labelStyles}>
      {label}
      <select
        className={fieldStyles}
        {...props}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
      >
        {children}
      </select>
      {hint && <span className={fieldHintStyles}>{hint}</span>}
    </label>
  );
}

export function Checkbox({
  label,
  hint,
  ...props
}: Label &
  Omit<
    ComponentProps<"input">,
    "checked" | "defaultChecked" | "onChange" | "onBlur" | "name" | "type"
  >) {
  const field = useFieldContext<boolean>();
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-ui">
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-accent"
        {...props}
        name={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint && <span className={fieldHintStyles}>{hint}</span>}
      </span>
    </label>
  );
}

/** Native validation and keyboard submission stay with the browser. */
export function Form({
  form,
  ...props
}: Omit<ComponentProps<"form">, "onSubmit"> & {
  form: { handleSubmit: () => Promise<void> };
}) {
  return (
    <form
      {...props}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    />
  );
}
