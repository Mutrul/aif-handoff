export function normalizeModelEffort(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeModelEffortLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeModelEffort(entry);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return unique.size > 0 ? [...unique] : undefined;
}
