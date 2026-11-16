export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEGACY_ALIASES: Record<string, ThinkingLevel> = {
  none: "off",
  "": "off",
};

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function canonicalThinkingLevel(value?: string | null): ThinkingLevel {
  const normalized = (value ?? "").trim().toLowerCase();
  if (isThinkingLevel(normalized)) return normalized;
  return LEGACY_ALIASES[normalized] ?? "off";
}

export function thinkingLevelOptions(
  supported: readonly string[] | null | undefined,
  current?: string | null,
): ThinkingLevel[] {
  const allowed = new Set<ThinkingLevel>(
    (supported ?? []).filter(isThinkingLevel),
  );
  if (allowed.size === 0) {
    for (const level of THINKING_LEVELS) allowed.add(level);
  }
  if ((current ?? "").trim()) allowed.add(canonicalThinkingLevel(current));
  return THINKING_LEVELS.filter((level) => allowed.has(level));
}
