/** Formats advertised by the export options endpoint. */
export type ExportFormat = "json" | "csv" | "geojson" | "osm";

export interface ExportResourceOption {
  id: string;
  formats: ExportFormat[];
}

export interface ExportGroupOption {
  id: string;
  resources: ExportResourceOption[];
}

export interface ExportLimits {
  includePairs: number;
  records: number;
  coordinates: number;
  archiveEntries: number;
}

/** The JSON contract returned by GET /api/v1/aip/export/options. */
export interface ExportOptions {
  groups: ExportGroupOption[];
  locales: string[];
  defaultLocale: string;
  limits: ExportLimits;
}
