import { z } from "zod";

/** New instance allocation refused; no account/resource receipt was created. */
export const InstanceCapacityFailureSchema = z.strictObject({
  kind: z.literal("instance_capacity"),
});
export type InstanceCapacityFailure = z.infer<
  typeof InstanceCapacityFailureSchema
>;
