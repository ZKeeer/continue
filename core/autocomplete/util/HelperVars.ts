import type { DocumentSymbol } from "../..";
import { IDE, TabAutocompleteOptions } from "../..";
import {
  estimateTokensFast,
  pruneLinesFromBottomFast,
  pruneLinesFromTopFast,
} from "../../llm/countTokens";
import { SymbolKind } from "../../util/symbolKind";
import {
  AutocompleteLanguageInfo,
  languageForFilepath,
} from "../constants/AutocompleteLanguageInfo";
import { constructInitialPrefixSuffix } from "../templating/constructPrefixSuffix";

import { AstPath, getAst, getTreePathAtCursor } from "./ast";
import { AutocompleteInput } from "./types";

// [zkdev] SymbolKinds that correspond to RootPathContextService.TYPES_TO_USE
const SCOPE_SYMBOL_KINDS = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
  SymbolKind.Constructor,
]);

/**
 * [zkdev] Module-level cache: scope signature → treePath.
 * Avoids blocking tree-sitter parse on every keystroke.
 * Key: "filepath|scopeSignature", Value: cached treePath.
 */
const scopeTreePathCache = new Map<
  string,
  { scopeKey: string; treePath: AstPath }
>();

/**
 * Find the enclosing scope chain from DocumentSymbol tree.
 * Returns a string key like "Function:process@10:0>Class:MyClass@5:0" — stable
 * as long as cursor stays in the same function/class.
 */
function computeScopeKey(
  symbols: DocumentSymbol[],
  line: number,
  character: number,
): string {
  const parts: string[] = [];

  function walk(syms: DocumentSymbol[]) {
    for (const sym of syms) {
      const r = sym.range;
      if (
        (line > r.start.line ||
          (line === r.start.line && character >= r.start.character)) &&
        (line < r.end.line ||
          (line === r.end.line && character <= r.end.character))
      ) {
        if (SCOPE_SYMBOL_KINDS.has(sym.kind)) {
          parts.push(
            `${SymbolKind[sym.kind]}:${sym.name}@${r.start.line}:${r.start.character}`,
          );
        }
        if (sym.children?.length) {
          walk(sym.children);
        }
        return; // deepest match first
      }
    }
  }

  walk(symbols);
  return parts.join(">");
}

// [zkdev] Module-level cache for getWorkspaceDirs() result.
// Workspace dirs rarely change during a session. Caching eliminates one IPC
// round-trip (~20-50ms) per autocomplete request.
let cachedWorkspaceDirs: string[] | undefined;

/**
 * A collection of variables that are often accessed throughout the autocomplete pipeline
 * It's noisy to re-calculate all the time or inject them into each function
 */
export class HelperVars {
  lang: AutocompleteLanguageInfo;
  treePath: AstPath | undefined;
  workspaceUris: string[] = [];
  /** [zkdev] Cached DocumentSymbols from init() for scope summary generation */
  private _documentSymbols: DocumentSymbol[] | undefined;

  private _fileContents: string | undefined;
  private _fileLines: string[] | undefined;
  private _fullPrefix: string | undefined;
  private _fullSuffix: string | undefined;
  private _prunedPrefix: string | undefined;
  private _prunedSuffix: string | undefined;

  private constructor(
    public readonly input: AutocompleteInput,
    public readonly options: TabAutocompleteOptions,
    public readonly modelName: string,
    private readonly ide: IDE,
  ) {
    this.lang = languageForFilepath(input.filepath);
  }

  private async init() {
    // Don't do anything if already initialized
    if (this._fileContents !== undefined) {
      return;
    }

    const t0 = Date.now();
    // [zkdev] Use cached workspace dirs to avoid IPC round-trip on every request
    if (cachedWorkspaceDirs) {
      this.workspaceUris = cachedWorkspaceDirs;
    } else {
      this.workspaceUris = await this.ide.getWorkspaceDirs();
      cachedWorkspaceDirs = this.workspaceUris;
    }
    const t1 = Date.now();

    this._fileContents =
      this.input.manuallyPassFileContents ??
      (await this.ide.readFile(this.filepath));

    // [zkdev] Strip IntelliJ dummy identifier that leaks into document text
    // during IntelliJ's completion context creation
    if (this._fileContents.includes("IntellijIdeaRulezzz")) {
      this._fileContents = this._fileContents.replace(
        /IntellijIdeaRulezzz\s*/g,
        "",
      );
    }

    // [zkdev] Ensure constructInitialPrefixSuffix reuses already-read file contents
    // instead of making a redundant IPC readFile call
    this.input.manuallyPassFileContents = this._fileContents;
    const t2 = Date.now();

    this._fileLines = this._fileContents.split("\n");

    // Construct full prefix/suffix (a few edge cases handled in here)
    const { prefix: fullPrefix, suffix: fullSuffix } =
      constructInitialPrefixSuffix(this.input, this._fileContents);
    const t3 = Date.now();
    this._fullPrefix = fullPrefix;
    this._fullSuffix = fullSuffix;

    const { prunedPrefix, prunedSuffix } = this.prunePrefixSuffix();
    const t4 = Date.now();
    this._prunedPrefix = prunedPrefix;
    this._prunedSuffix = prunedSuffix;

    // [zkdev] DocumentSymbol scope detection: use IDE-provided symbols (tree structure)
    // to determine if cursor is still in the same scope → reuse cached treePath.
    // Scope change → treePath=undefined for this request, background parse populates cache.
    // [zkdev] JetBrains compatibility: getDocumentSymbols throws NotImplementedError in IntelliJIde.
    // Wrap in try-catch so PyCharm/IDEA autocomplete continues to work (falls back to no-symbol path).
    const cacheKey = this.filepath;
    const cached = scopeTreePathCache.get(cacheKey);
    let symbols: DocumentSymbol[] = [];
    try {
      symbols = (await this.ide.getDocumentSymbols(this.filepath)) ?? [];
    } catch {
      // getDocumentSymbols may fail (IDE indexing not ready, unsupported IDE, IPC error)
    }
    this._documentSymbols = symbols;

    if (symbols && symbols.length > 0) {
      const scopeKey = computeScopeKey(
        symbols,
        this.pos.line,
        this.pos.character,
      );
      if (cached && cached.scopeKey === scopeKey) {
        this.treePath = cached.treePath;
        console.log(
          `[HelperVars ScopeCache] HIT scopeKey="${scopeKey}" treePathLen=${this.treePath?.length ?? "undefined"}`,
        );
      } else {
        this.treePath = undefined;
        this._fireBackgroundParse(cacheKey, scopeKey);
        console.log(
          `[HelperVars ScopeCache] MISS oldKey="${cached?.scopeKey ?? "none"}" newKey="${scopeKey}" → background parse fired`,
        );
      }
    } else {
      // DocumentSymbol unavailable — reuse cached treePath or fire background parse
      if (cached) {
        this.treePath = cached.treePath;
      } else {
        this.treePath = undefined;
        this._fireBackgroundParse(cacheKey, "");
      }
    }
    const t5 = Date.now();

    // [zkdev] HelperVars.init() sub-timing breakdown
    console.log(
      `[HelperVars SubTimings] ` +
        `workspaceDirsMs=${t1 - t0} ` +
        `readFileMs=${t2 - t1} ` +
        `constructPrefixSuffixMs=${t3 - t2} ` +
        `prunePrefixSuffixMs=${t4 - t3} ` +
        `scopeDetectMs=${t5 - t4} ` +
        `totalInitMs=${t5 - t0}`,
    );
  }

  /** [zkdev] Fire non-blocking background tree-sitter parse to populate scopeTreePathCache. */
  private _fireBackgroundParse(cacheKey: string, scopeKey: string) {
    const fileContents = this._fileContents!;
    const fileLines = this._fileLines!;
    const filepath = this.filepath;
    const posLine = this.pos.line;
    const posChar = this.pos.character;

    void (async () => {
      try {
        const ast = await getAst(filepath, fileContents);
        if (ast) {
          let cursorIndex = 0;
          for (let i = 0; i < posLine && i < fileLines.length; i++) {
            cursorIndex += fileLines[i].length + 1;
          }
          cursorIndex += posChar;
          const treePath = await getTreePathAtCursor(ast, cursorIndex);
          scopeTreePathCache.set(cacheKey, { scopeKey, treePath });
          console.log(
            `[HelperVars BackgroundParse] OK file=${filepath} treePathLen=${treePath?.length ?? 0}` +
              (treePath?.length
                ? ` types=[${treePath.map((n) => n.type).join(",")}]`
                : ""),
          );
        } else {
          console.warn(
            `[HelperVars BackgroundParse] getAst returned undefined for ${filepath}`,
          );
        }
      } catch (e) {
        console.error("[HelperVars] Background AST parse failed", e);
      }
    })();
  }

  static async create(
    input: AutocompleteInput,
    options: TabAutocompleteOptions,
    modelName: string,
    ide: IDE,
  ): Promise<HelperVars> {
    const t_create = Date.now();
    const instance = new HelperVars(input, options, modelName, ide);
    await instance.init();
    console.log(
      `[HelperVars] create() total=${Date.now() - t_create}ms (includes constructor + init)`,
    );
    return instance;
  }

  prunePrefixSuffix() {
    // [zkdev] Use fast character-based estimation instead of per-line tokenization.
    // Saves 2000-3000ms by avoiding hundreds of llamaTokenizer.encode() calls.
    // The precise token budget is enforced later in templating if the prompt overflows.
    const maxPrefixTokens =
      this.options.maxPromptTokens * this.options.prefixPercentage;
    const prunedPrefix = pruneLinesFromTopFast(
      this.fullPrefix,
      maxPrefixTokens,
    );

    const maxSuffixTokens = Math.min(
      this.options.maxPromptTokens - estimateTokensFast(prunedPrefix),
      this.options.maxSuffixPercentage * this.options.maxPromptTokens,
    );
    const prunedSuffix = pruneLinesFromBottomFast(
      this.fullSuffix,
      maxSuffixTokens,
    );

    return {
      prunedPrefix,
      prunedSuffix,
    };
  }

  // Fast access
  get filepath() {
    return this.input.filepath;
  }
  get pos() {
    return this.input.pos;
  }

  get prunedCaretWindow() {
    return this.prunedPrefix + this.prunedSuffix;
  }

  // Getters for lazy access
  get fileContents(): string {
    if (this._fileContents === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing fileContents",
      );
    }
    return this._fileContents;
  }

  get fileLines(): string[] {
    if (this._fileLines === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing fileLines",
      );
    }
    return this._fileLines;
  }

  get fullPrefix(): string {
    if (this._fullPrefix === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing fullPrefix",
      );
    }
    return this._fullPrefix;
  }

  get fullSuffix(): string {
    if (this._fullSuffix === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing fullSuffix",
      );
    }
    return this._fullSuffix;
  }

  get prunedPrefix(): string {
    if (this._prunedPrefix === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing prunedPrefix",
      );
    }
    return this._prunedPrefix;
  }

  get prunedSuffix(): string {
    if (this._prunedSuffix === undefined) {
      throw new Error(
        "HelperVars must be initialized before accessing prunedSuffix",
      );
    }
    return this._prunedSuffix;
  }

  /**
   * [zkdev] Generate scope summary snippet from DocumentSymbols.
   * Step 1: Class/module method signature list — gives LLM structural context
   * Step 2: Sibling method bodies for self.xxx() calls in current scope
   *
   * Returns a single code snippet or undefined if no useful context available.
   */
  getScopeSummarySnippet():
    | {
        content: string;
        filepath: string;
      }
    | undefined {
    const symbols = this._documentSymbols;
    if (!symbols || symbols.length === 0) return undefined;

    const line = this.pos.line;
    const char = this.pos.character;

    // Find the enclosing class or module-level scope and the current method
    let enclosingClass: DocumentSymbol | undefined;
    let currentMethod: DocumentSymbol | undefined;

    function findScope(syms: DocumentSymbol[]) {
      for (const sym of syms) {
        const r = sym.range;
        const inside =
          (line > r.start.line ||
            (line === r.start.line && char >= r.start.character)) &&
          (line < r.end.line ||
            (line === r.end.line && char <= r.end.character));
        if (!inside) continue;

        if (sym.kind === SymbolKind.Class || sym.kind === SymbolKind.Module) {
          enclosingClass = sym;
          // Check children for current method
          if (sym.children) {
            for (const child of sym.children) {
              const cr = child.range;
              const childInside =
                (line > cr.start.line ||
                  (line === cr.start.line && char >= cr.start.character)) &&
                (line < cr.end.line ||
                  (line === cr.end.line && char <= cr.end.character));
              if (
                childInside &&
                (child.kind === SymbolKind.Method ||
                  child.kind === SymbolKind.Function ||
                  child.kind === SymbolKind.Constructor)
              ) {
                currentMethod = child;
              }
            }
          }
        }
        // Recurse into children
        if (sym.children) findScope(sym.children);
      }
    }
    findScope(symbols);

    if (!enclosingClass || !enclosingClass.children) return undefined;

    // --- Step 1: Method signature list ---
    const sigLines: string[] = [];
    for (const child of enclosingClass.children) {
      if (
        child.kind === SymbolKind.Method ||
        child.kind === SymbolKind.Function ||
        child.kind === SymbolKind.Constructor ||
        child.kind === SymbolKind.Property
      ) {
        // Extract the signature line from file content
        const startLine =
          child.selectionRange?.start?.line ?? child.range.start.line;
        if (startLine < this.fileLines.length) {
          const sigLine = this.fileLines[startLine].trimEnd();
          if (sigLine) {
            sigLines.push(sigLine);
          }
        }
      }
    }

    if (sigLines.length === 0) return undefined;

    // --- Step 2: Call target definitions (sibling method bodies) ---
    const callTargetLines: string[] = [];
    if (currentMethod) {
      // Extract current method body from prefix/suffix to find self.xxx() calls
      const methodStart = currentMethod.range.start.line;
      const methodEnd = currentMethod.range.end.line;
      const methodBody = this.fileLines
        .slice(methodStart, Math.min(methodEnd + 1, this.fileLines.length))
        .join("\n");

      // Find self.xxx( (Python), this.xxx( (JS/TS/Java/C#), this->xxx( (C++)
      const callPattern = /(?:self|this)(?:->|\.)(\w+)\s*\(/g;
      const calledMethods = new Set<string>();
      let match;
      while ((match = callPattern.exec(methodBody)) !== null) {
        calledMethods.add(match[1]);
      }

      // For each called method, find sibling definition and extract first few lines
      if (calledMethods.size > 0) {
        for (const child of enclosingClass.children) {
          if (!calledMethods.has(child.name)) continue;
          if (child === currentMethod) continue; // skip self
          if (
            child.kind !== SymbolKind.Method &&
            child.kind !== SymbolKind.Function &&
            child.kind !== SymbolKind.Constructor
          ) {
            continue;
          }

          const defStart = child.range.start.line;
          const defEnd = child.range.end.line;
          // Take first 6 lines of the method (signature + initial logic)
          const maxLines = Math.min(
            defStart + 6,
            defEnd + 1,
            this.fileLines.length,
          );
          const defLines = this.fileLines.slice(defStart, maxLines);
          if (defLines.length > 0) {
            callTargetLines.push(...defLines);
            if (maxLines < defEnd + 1) {
              callTargetLines.push("        ...");
            }
          }
        }
      }
    }

    // Build final content
    const parts: string[] = [];
    // [zkdev] Language-aware class declaration header
    // Python uses `class Name:`, other C-family languages use `class Name {`
    const classHeader =
      this.lang.name === "Python"
        ? `class ${enclosingClass.name}:`
        : `class ${enclosingClass.name} {`;
    parts.push(classHeader);
    for (const sig of sigLines) {
      parts.push(sig);
    }

    if (callTargetLines.length > 0) {
      parts.push(""); // blank line separator
      // [zkdev] Use language singleLineComment for portability across C++/Java/JS/Python
      const commentPrefix = this.lang.singleLineComment || "#";
      parts.push(`${commentPrefix} called method definitions:`);
      parts.push(...callTargetLines);
    }

    return {
      content: parts.join("\n"),
      filepath: this.filepath,
    };
  }
}
