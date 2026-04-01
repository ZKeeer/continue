import { IDE, RangeInFileWithContents } from "../..";
import { PrecalculatedLruCache } from "../../util/LruCache";
import {
    getFullLanguageName,
    getParserForFile,
    getQueryForFile,
} from "../../util/treeSitter";
import { findUriInDirs } from "../../util/uri";
import { GotoDefinitionCache } from "./GotoDefinitionCache";

interface FileInfo {
  imports: { [key: string]: RangeInFileWithContents[] };
}

export class ImportDefinitionsService {
  static N = 10;

  private cache: PrecalculatedLruCache<FileInfo> =
    new PrecalculatedLruCache<FileInfo>(
      this._getFileInfo.bind(this),
      ImportDefinitionsService.N,
    );

  constructor(
    private readonly ide: IDE,
    private readonly gotoDefCache?: GotoDefinitionCache,
  ) {
    ide.onDidChangeActiveTextEditor((filepath) => {
      this.cache
        .initKey(filepath)
        .catch((e) =>
          console.warn(
            `Failed to initialize ImportDefinitionService: ${e.message}`,
          ),
        );
    });
  }

  get(filepath: string): FileInfo | undefined {
    return this.cache.get(filepath);
  }

  private async _getFileInfo(filepath: string): Promise<FileInfo | null> {
    if (filepath.endsWith(".ipynb")) {
      // Commenting out this line was the solution to https://github.com/continuedev/continue/issues/1463
      return null;
    }

    const parser = await getParserForFile(filepath);
    if (!parser) {
      return {
        imports: {},
      };
    }

    let fileContents: string | undefined = undefined;
    try {
      const { foundInDir } = findUriInDirs(
        filepath,
        await this.ide.getWorkspaceDirs(),
      );
      if (!foundInDir) {
        return null;
      } else {
        fileContents = await this.ide.readFile(filepath);
      }
    } catch (err) {
      // File removed
      return null;
    }

    const ast = parser.parse(fileContents, undefined, {
      includedRanges: [
        {
          startIndex: 0,
          endIndex: 10_000,
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 100, column: 0 },
        },
      ],
    });
    const language = getFullLanguageName(filepath);
    const query = await getQueryForFile(
      filepath,
      `import-queries/${language}.scm`,
    );
    if (!query) {
      return {
        imports: {},
      };
    }

    const matches = query?.matches(ast.rootNode);

    const fileInfo: FileInfo = {
      imports: {},
    };

    // [zkdev] Parallelize gotoDefinition calls + 150ms timeout per call
    // Original code was serial for-loop, causing 200ms*N sequential latency
    const importResults = await Promise.all(
      matches.map(async (match) => {
        const symbolName = match.captures[0].node.text;
        const startPosition = match.captures[0].node.startPosition;
        const location = {
          filepath,
          position: {
            line: startPosition.row,
            character: startPosition.column,
          },
        };
        const gotoFn = this.gotoDefCache
          ? this.gotoDefCache.gotoDefinition(location)
          : this.ide.gotoDefinition(location);
        const defs = await Promise.race([
          gotoFn,
          new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 150)),
        ]);
        const ranges = await Promise.all(
          defs.map(async (def) => ({
            ...def,
            contents: await this.ide.readRangeInFile(def.filepath, def.range),
          })),
        );
        return { symbolName, ranges };
      }),
    );
    for (const { symbolName, ranges } of importResults) {
      fileInfo.imports[symbolName] = ranges;
    }

    return fileInfo;
  }
}
