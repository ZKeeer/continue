/**
 * [zkdev] P1-7/8: Project-internal function definition cache for autocomplete context.
 *
 * Stores: filepath, funcName, params, docstring (structured, minimal).
 * Key: funcName (simple, last-write-wins on collision — acceptable for context).
 *
 * Cache sources (priority):
 *   1. IDE gotoDefinition → parse definition site
 *   2. Self-parse from opened/edited files via regex (warmFile)
 */

import { IDE, RangeInFile } from "../..";
import { findUriInDirs } from "../../util/uri";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
} from "../snippets/types";

export interface DefinitionEntry {
  filepath: string;
  funcName: string;
  params: string;
  returnType: string;
  docstring: string;
  updatedAt: number;
}

const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

const CALL_PATTERN = /(?:(?:self|this|[a-zA-Z_]\w*)\.)?([a-zA-Z_]\w{2,})\s*\(/g;

/** Common keywords/builtins to skip */
const SKIP_NAMES = new Set([
  // JS/TS
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "instanceof",
  "new",
  "delete",
  "void",
  "throw",
  "require",
  "import",
  "export",
  "console",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Map",
  "Set",
  "Error",
  "RegExp",
  "JSON",
  "Math",
  "Date",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  // Python
  "def",
  "class",
  "print",
  "len",
  "range",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "list",
  "dict",
  "set",
  "tuple",
  "str",
  "int",
  "float",
  "bool",
  "type",
  "super",
  "isinstance",
  "issubclass",
  "hasattr",
  "getattr",
  "setattr",
  "open",
  "iter",
  "next",
  "vars",
  "dir",
  "abs",
  "min",
  "max",
  "sum",
  "any",
  "all",
  "ord",
  "chr",
  "hex",
  "oct",
  "bin",
  "hash",
  "id",
  "repr",
  "format",
  "input",
  "round",
  "reversed",
]);

/**
 * Regex patterns to find function/method definitions in source code.
 * Used for self-parse fallback when IDE gotoDefinition is unavailable.
 */
const DEF_PATTERNS = [
  /^(\s*(?:async\s+)?def\s+(\w+)\s*\()/, // Python
  /^(\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[\(<])/, // JS/TS function
  /^(\s*(?:(?:public|private|protected|internal|static|abstract|override|async|suspend|get|set|fun|void|int|string|boolean|number|any)\s+)*(\w+)\s*[\(<])/, // method
  /^(\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>)/, // arrow
  /^(\s*func\s+(\w+)\s*\()/, // Go
  /^(\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[\(<])/, // Rust
  /^(\s*def\s+(\w+))/, // Ruby
];

export class DefinitionCacheService {
  private cache = new Map<string, DefinitionEntry>();

  constructor(private readonly ide: IDE) {}

  // ── Public API ───────────────────────────────────────────────

  async getDefinitionsForContext(
    prefix: string,
    suffix: string,
    currentFilepath: string,
    workspaceDirs: string[],
    timeoutMs: number = 300,
  ): Promise<AutocompleteCodeSnippet[]> {
    const callNames = this.extractCallNames(prefix, suffix);
    if (callNames.length === 0) return [];

    const results: AutocompleteCodeSnippet[] = [];
    const unresolvedNames: string[] = [];

    for (const name of callNames) {
      const entry = this.cache.get(name);
      if (entry && Date.now() - entry.updatedAt < CACHE_TTL_MS) {
        results.push(this.entryToSnippet(entry));
      } else {
        unresolvedNames.push(name);
      }
    }

    if (unresolvedNames.length === 0) return results;

    try {
      const resolved = await Promise.race([
        this.resolveDefinitions(
          unresolvedNames,
          currentFilepath,
          workspaceDirs,
        ),
        new Promise<DefinitionEntry[]>((resolve) =>
          setTimeout(() => resolve([]), timeoutMs),
        ),
      ]);
      for (const entry of resolved) {
        results.push(this.entryToSnippet(entry));
      }
    } catch {
      // Non-critical
    }

    return results;
  }

  warmFile(filepath: string, content: string): void {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of DEF_PATTERNS) {
        const m = lines[i].match(pattern);
        if (m && m[2]) {
          const funcName = m[2];
          if (SKIP_NAMES.has(funcName) || funcName.startsWith("_")) continue;

          const params = this.extractParams(lines, i);
          const returnType = this.extractReturnType(lines, i);
          const docstring = this.extractDocstring(lines, i, params);

          this.setCacheEntry(funcName, {
            filepath,
            funcName,
            params,
            returnType,
            docstring,
            updatedAt: Date.now(),
          });
        }
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────

  private extractCallNames(prefix: string, suffix: string): string[] {
    const text =
      prefix.split("\n").slice(-10).join("\n") +
      "\n" +
      suffix.split("\n").slice(0, 5).join("\n");

    const names = new Set<string>();
    const re = new RegExp(CALL_PATTERN.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      if (name && !SKIP_NAMES.has(name) && name.length > 2) {
        names.add(name);
      }
    }
    return Array.from(names);
  }

  /** Extract parameter list from definition line(s). Handles multi-line params. */
  private extractParams(lines: string[], startLine: number): string {
    let depth = 0;
    let started = false;
    const parts: string[] = [];

    for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
      for (const ch of lines[i]) {
        if (ch === "(") {
          if (!started) {
            started = true;
            depth = 1;
            continue;
          }
          depth++;
        } else if (ch === ")") {
          depth--;
          if (depth === 0) {
            return parts.join("").trim();
          }
        }
        if (started && depth > 0) {
          parts.push(ch);
        }
      }
      if (started) parts.push(" "); // collapse newline to space
    }
    return parts.join("").trim();
  }

  /** Extract return type annotation from definition line(s).
   *  Handles: `-> type` (Python/Rust), `: type` (TS/Kotlin), bare type (Go). */
  private extractReturnType(lines: string[], startLine: number): string {
    let depth = 0;
    let started = false;
    let afterParen = "";

    outer: for (
      let i = startLine;
      i < Math.min(startLine + 10, lines.length);
      i++
    ) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        if (line[j] === "(") {
          started = true;
          depth++;
        } else if (line[j] === ")") {
          depth--;
          if (started && depth === 0) {
            afterParen = line.substring(j + 1).trim();
            break outer;
          }
        }
      }
    }

    if (!afterParen) return "";

    // Strip opening brace and everything after
    afterParen = afterParen.replace(/\{.*$/, "").trim();
    // Strip trailing colon (Python) and semicolons
    afterParen = afterParen.replace(/[:;]\s*$/, "").trim();

    // -> type (Python, Rust)
    const arrowMatch = afterParen.match(/->\s*(.+)/);
    if (arrowMatch) return arrowMatch[1].trim();

    // : type (TS, Kotlin)
    const colonMatch = afterParen.match(/:\s*(.+)/);
    if (colonMatch) return colonMatch[1].trim();

    // Go: bare type after )
    if (afterParen && /^[\w(]/.test(afterParen)) return afterParen;

    return "";
  }

  /** Extract docstring/JSDoc immediately after the function signature. */
  private extractDocstring(
    lines: string[],
    defLine: number,
    params: string,
  ): string {
    // Find the line where params end (signature closes)
    let sigEndLine = defLine;
    let depth = 0;
    let started = false;
    for (let i = defLine; i < Math.min(defLine + 10, lines.length); i++) {
      for (const ch of lines[i]) {
        if (ch === "(") {
          started = true;
          depth++;
        }
        if (ch === ")") {
          depth--;
          if (started && depth === 0) {
            sigEndLine = i;
            break;
          }
        }
      }
      if (started && depth === 0) break;
    }

    // Look for docstring in next few lines
    const result: string[] = [];
    let inDoc = false;
    for (
      let i = sigEndLine + 1;
      i < Math.min(sigEndLine + 12, lines.length);
      i++
    ) {
      const trimmed = lines[i].trim();

      if (!inDoc) {
        // Skip empty lines and colon/brace openers
        if (trimmed === "" || trimmed === ":" || trimmed === "{") continue;
        // Detect docstring start
        if (
          trimmed.startsWith('"""') ||
          trimmed.startsWith("'''") ||
          trimmed.startsWith("/**") ||
          trimmed.startsWith("///") ||
          trimmed.startsWith("//!")
        ) {
          inDoc = true;
          result.push(trimmed);
          // Single-line docstring
          if (this.isDocstringClosed(trimmed)) return result.join("\n");
          continue;
        }
        // No docstring found
        break;
      }

      // Inside docstring
      result.push(trimmed);
      if (this.isDocstringClosed(trimmed)) break;
    }
    return result.join("\n");
  }

  private isDocstringClosed(line: string): boolean {
    // Single-line: """text""", '''text''', /** text */
    if (line.startsWith('"""') && line.endsWith('"""') && line.length > 3)
      return true;
    if (line.startsWith("'''") && line.endsWith("'''") && line.length > 3)
      return true;
    if (line.startsWith("/**") && line.endsWith("*/")) return true;
    // Closing markers
    if (line.endsWith('"""') || line.endsWith("'''") || line.endsWith("*/"))
      return true;
    return false;
  }

  private async resolveDefinitions(
    names: string[],
    currentFilepath: string,
    workspaceDirs: string[],
  ): Promise<DefinitionEntry[]> {
    const results: DefinitionEntry[] = [];
    await Promise.all(
      names.map(async (name) => {
        const entry = await this.resolveViaIde(
          name,
          currentFilepath,
          workspaceDirs,
        );
        if (entry) results.push(entry);
      }),
    );
    return results;
  }

  private async resolveViaIde(
    name: string,
    currentFilepath: string,
    workspaceDirs: string[],
  ): Promise<DefinitionEntry | null> {
    let fileContent: string;
    try {
      fileContent = await this.ide.readFile(currentFilepath);
    } catch {
      return null;
    }

    const namePattern = new RegExp(`\\b${this.escapeRegex(name)}\\s*\\(`);
    const lines = fileContent.split("\n");
    let targetLine = -1;
    let targetCol = -1;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(namePattern);
      if (m && m.index !== undefined) {
        targetLine = i;
        targetCol = m.index;
        break;
      }
    }
    if (targetLine < 0) return null;

    const defs: RangeInFile[] = await Promise.race([
      this.ide.gotoDefinition({
        filepath: currentFilepath,
        position: { line: targetLine, character: targetCol },
      }),
      new Promise<RangeInFile[]>((resolve) =>
        setTimeout(() => resolve([]), 200),
      ),
    ]);

    if (!defs || defs.length === 0) return null;
    const def = defs[0];

    try {
      if (!findUriInDirs(def.filepath, workspaceDirs).foundInDir) return null;
    } catch {
      return null;
    }

    // Read ~15 lines from definition site
    const defContent = await this.ide.readRangeInFile(def.filepath, {
      start: { line: def.range.start.line, character: 0 },
      end: { line: Math.min(def.range.start.line + 15, 999999), character: 0 },
    });
    if (!defContent || defContent.trim().length === 0) return null;

    const defLines = defContent.split("\n");
    const params = this.extractParams(defLines, 0);
    const returnType = this.extractReturnType(defLines, 0);
    const docstring = this.extractDocstring(defLines, 0, params);

    const entry: DefinitionEntry = {
      filepath: def.filepath,
      funcName: name,
      params,
      returnType,
      docstring,
      updatedAt: Date.now(),
    };
    this.setCacheEntry(name, entry);
    return entry;
  }

  private setCacheEntry(funcName: string, entry: DefinitionEntry): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, val] of this.cache) {
        if (val.updatedAt < oldestTime) {
          oldestTime = val.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(funcName, entry);
  }

  private entryToSnippet(entry: DefinitionEntry): AutocompleteCodeSnippet {
    // Reconstruct minimal context: funcName(params) -> returnType + docstring
    let content = `${entry.funcName}(${entry.params})`;
    if (entry.returnType) {
      content += ` -> ${entry.returnType}`;
    }
    if (entry.docstring) {
      content += "\n" + entry.docstring;
    }
    return {
      filepath: entry.filepath,
      content,
      type: AutocompleteSnippetType.Code,
    };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
