import { createFormHook } from "@tanstack/react-form";
import { fieldContext, formContext } from "./context";
import { TextField, SelectField, Checkbox } from "./controls";

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, SelectField, Checkbox },
  formComponents: {},
});
