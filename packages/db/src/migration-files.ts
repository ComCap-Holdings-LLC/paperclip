export function isMigrationFileName(name: string): boolean {
  return name.endsWith(".sql") && !name.startsWith("._") && !name.startsWith(".");
}

export function listMigrationFileNames(names: readonly string[]): string[] {
  return names.filter(isMigrationFileName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
