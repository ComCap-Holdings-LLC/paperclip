export function isMigrationFileName(name: string): boolean {
  return name.endsWith(".sql") && !name.startsWith("._") && !name.startsWith(".");
}

export function compareMigrationFileNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function listMigrationFileNames(names: readonly string[]): string[] {
  return names.filter(isMigrationFileName).sort(compareMigrationFileNames);
}
