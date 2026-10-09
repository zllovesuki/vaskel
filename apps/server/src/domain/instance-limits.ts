const limits = {
  INSTANCE_ACCOUNT_LIMIT: { defaultValue: 256, maximum: 4_096 },
  INSTANCE_SERVER_LIMIT: { defaultValue: 32, maximum: 1_024 },
  INSTANCE_CONVERSATION_LIMIT: { defaultValue: 512, maximum: 16_384 },
} as const;

/** Configuration bounds are admission choices, not measured supported loads. */
export function instanceLimit(
  name: keyof typeof limits,
  config: string | undefined,
): number {
  const { defaultValue, maximum } = limits[name];
  if (config === undefined) return defaultValue;
  const value = /^\d+$/.test(config) ? Number(config) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}
