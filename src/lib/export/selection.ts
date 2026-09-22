import type { Locale } from "@/lib/i18n";
import type {
  ExportFormat,
  ExportOptions,
  ExportResourceOption,
} from "@/lib/export/options";

function includeFor(resource: string, format: ExportFormat): string {
  return `${resource}.${format}`;
}

function resourcePairs(resource: ExportResourceOption): string[] {
  return resource.formats.map((format) => includeFor(resource.id, format));
}

function orderedSupportedPairs(options: ExportOptions): string[] {
  return options.groups.flatMap((group) =>
    group.resources.flatMap((resource) => resourcePairs(resource)),
  );
}

export function createDefaultSelection(options: ExportOptions): Set<string> {
  return new Set(
    options.groups.flatMap((group) =>
      group.resources
        .filter((resource) => resource.formats.includes("json"))
        .map((resource) => includeFor(resource.id, "json")),
    ),
  );
}

export function normalizeSelection(
  options: ExportOptions,
  selected: ReadonlySet<string>,
): Set<string> {
  return new Set(
    orderedSupportedPairs(options).filter((include) => selected.has(include)),
  );
}

export function toggleGroupFormat(
  options: ExportOptions,
  selected: ReadonlySet<string>,
  groupId: string,
  format: ExportFormat,
  enabled: boolean,
): Set<string> {
  const next = normalizeSelection(options, selected);
  const group = options.groups.find(({ id }) => id === groupId);
  if (!group) return next;

  for (const resource of group.resources) {
    if (!resource.formats.includes(format)) continue;
    const include = includeFor(resource.id, format);
    if (enabled) next.add(include);
    else next.delete(include);
  }

  return normalizeSelection(options, next);
}

export function buildExportSearch(
  selected: ReadonlySet<string>,
  locale: Locale,
  airports: Iterable<string> = [],
): URLSearchParams {
  const params = new URLSearchParams();
  for (const include of [...selected].sort()) {
    params.append("include", include);
  }
  for (const airport of [
    ...new Set([...airports].map((value) => value.toUpperCase())),
  ].sort()) {
    params.append("airport", airport);
  }
  params.set("locale", locale);
  return params;
}
