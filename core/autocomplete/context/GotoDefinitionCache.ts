import { LRUCache } from "lru-cache";

import { IDE, Location, RangeInFile } from "../..";

/**
 * Caches gotoDefinition LSP results to avoid repeated expensive calls.
 * Key: filepath:line:character, Value: RangeInFile[], TTL: 3 minutes.
 *
 * Note: Key does not include document version, so results may be stale after edits.
 * The short TTL (3min) limits staleness. For autocomplete snippet context this is
 * acceptable — stale definitions only affect context quality, not completion correctness.
 */
export class GotoDefinitionCache {
  private cache: LRUCache<string, RangeInFile[]>;

  constructor(
    private readonly ide: IDE,
    ttlMs: number = 3 * 60 * 1000,
    maxEntries: number = 500,
  ) {
    this.cache = new LRUCache<string, RangeInFile[]>({
      max: maxEntries,
      ttl: ttlMs,
    });
  }

  private static makeKey(location: Location): string {
    return `${location.filepath}:${location.position.line}:${location.position.character}`;
  }

  async gotoDefinition(location: Location): Promise<RangeInFile[]> {
    const key = GotoDefinitionCache.makeKey(location);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.ide.gotoDefinition(location);
    this.cache.set(key, result);
    return result;
  }
}
