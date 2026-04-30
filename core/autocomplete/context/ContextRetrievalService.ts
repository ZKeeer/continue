import { IDE } from "../..";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
  AutocompleteStaticSnippet,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

import { GotoDefinitionCache } from "./GotoDefinitionCache";
import { ImportDefinitionsService } from "./ImportDefinitionsService";
import { getSymbolsForSnippet } from "./ranking";
import { RootPathContextService } from "./root-path-context/RootPathContextService";
import { StaticContextService } from "./static-context/StaticContextService";

export class ContextRetrievalService {
  private importDefinitionsService: ImportDefinitionsService;
  private rootPathContextService: RootPathContextService;
  private staticContextService: StaticContextService;

  constructor(private readonly ide: IDE) {
    const gotoDefCache = new GotoDefinitionCache(this.ide);
    this.importDefinitionsService = new ImportDefinitionsService(
      this.ide,
      gotoDefCache,
    );
    this.rootPathContextService = new RootPathContextService(
      this.importDefinitionsService,
      this.ide,
      gotoDefCache,
    );
    this.staticContextService = new StaticContextService(this.ide);
  }

  public async getSnippetsFromImportDefinitions(
    helper: HelperVars,
  ): Promise<AutocompleteCodeSnippet[]> {
    if (helper.options.useImports === false) {
      return [];
    }

    const importSnippets: AutocompleteCodeSnippet[] = [];
    const fileInfo = this.importDefinitionsService.get(helper.filepath);
    if (fileInfo) {
      const { imports } = fileInfo;
      // Look for imports of any symbols around the current range
      const textAroundCursor =
        helper.fullPrefix.split("\n").slice(-5).join("\n") +
        helper.fullSuffix.split("\n").slice(0, 3).join("\n");
      const symbols = Array.from(getSymbolsForSnippet(textAroundCursor)).filter(
        (symbol) => !helper.lang.topLevelKeywords.includes(symbol),
      );
      for (const symbol of symbols) {
        const rifs = imports[symbol];
        if (Array.isArray(rifs)) {
          const snippets: AutocompleteCodeSnippet[] = rifs.map((rif) => {
            return {
              filepath: rif.filepath,
              content: rif.contents,
              type: AutocompleteSnippetType.Code,
            };
          });

          importSnippets.push(...snippets);
        }
      }
    }

    return importSnippets;
  }

  public async getRootPathSnippets(
    helper: HelperVars,
  ): Promise<AutocompleteCodeSnippet[]> {
    if (!helper.treePath) {
      return [];
    }

    return this.rootPathContextService.getContextForPath(
      helper.filepath,
      helper.treePath,
    );
  }

  public async getStaticContextSnippets(
    helper: HelperVars,
  ): Promise<AutocompleteStaticSnippet[]> {
    return this.staticContextService.getContext(helper);
  }

  /**
   * Initialize the import definitions cache for a file.
   * This is normally done automatically when the active text editor changes,
   * but needs to be called manually when using context fetching outside the normal flow.
   */
  public async initializeForFile(filepath: string): Promise<void> {
    try {
      await (this.importDefinitionsService as any).cache.initKey(filepath);
    } catch (e) {
      console.warn(
        `Failed to initialize import definitions cache for ${filepath}:`,
        e,
      );
    }
  }

  /**
   * Get raw import definition data for a file.
   * Returns import symbol → definition content mappings.
   * Used by QueueManager warming to populate importQueue.
   */
  public getImportDefinitionsForFile(
    filepath: string,
  ): {
    symbolName: string;
    defFilepath: string;
    content: string;
    startLine: number;
    endLine: number;
  }[] {
    const fileInfo = this.importDefinitionsService.get(filepath);
    if (!fileInfo) {
      return [];
    }

    const result: {
      symbolName: string;
      defFilepath: string;
      content: string;
      startLine: number;
      endLine: number;
    }[] = [];
    for (const [symbolName, rifs] of Object.entries(fileInfo.imports)) {
      for (const rif of rifs) {
        if (rif.contents) {
          result.push({
            symbolName,
            defFilepath: rif.filepath,
            content: rif.contents,
            startLine: rif.range.start.line,
            endLine: rif.range.end.line,
          });
        }
      }
    }
    return result;
  }
}
