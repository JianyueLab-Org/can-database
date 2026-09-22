export function airportExportHref(icao: string): string {
  const params = new URLSearchParams({ airport: icao.toUpperCase() });
  return `/export?${params}`;
}
