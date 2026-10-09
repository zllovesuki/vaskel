import { z } from "zod";

export type Tag<T, Key extends string> =
  T extends Record<Key, infer Value> ? Extract<Value, string> : never;

type Variant<T, Key extends string, Value extends string> =
  T extends Record<Key, infer Tag>
    ? Tag & Value extends never
      ? never
      : T & Record<Key, Value>
    : never;

/** Select executable variants from the actor contract without copying their fields. */
export function variant<
  Schema extends z.ZodType,
  Key extends string,
  const Value extends Tag<z.output<Schema>, Key>,
>(
  schema: Schema,
  key: Key,
  ...values: Value[]
): z.ZodType<
  Variant<z.output<Schema>, Key, Value>,
  Variant<z.input<Schema>, Key, Value>
> {
  const selected: z.ZodType[] = [];
  function visit(candidate: z.ZodType) {
    if (candidate instanceof z.ZodUnion) {
      for (const option of candidate.options) visit(option as z.ZodType);
    } else if (candidate instanceof z.ZodObject) {
      const tag = candidate.shape[key] as z.ZodType | undefined;
      const accepted = values.filter((value) => tag?.safeParse(value).success);
      if (accepted.length)
        selected.push(candidate.safeExtend({ [key]: z.enum(accepted) }));
    }
  }
  visit(schema);
  if (!selected.length)
    throw new Error(`Missing contract variant: ${values.join(", ")}`);
  return (
    selected.length === 1 ? selected[0]! : z.union(selected)
  ) as z.ZodType<
    Variant<z.output<Schema>, Key, Value>,
    Variant<z.input<Schema>, Key, Value>
  >;
}
export const outcome = <
  S extends z.ZodType,
  const V extends Tag<z.output<S>, "kind">,
>(
  schema: S,
  ...values: V[]
) => variant<S, "kind", V>(schema, "kind", ...values);
export const identityResult = <
  S extends z.ZodType,
  const V extends Tag<z.output<S>, "status">,
>(
  schema: S,
  ...values: V[]
) => variant<S, "status", V>(schema, "status", ...values);
