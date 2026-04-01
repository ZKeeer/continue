import Parser from "web-tree-sitter";

import { RangeInFileWithContents } from "../../";
import { getParserForFile } from "../../util/treeSitter";

export type AstPath = Parser.SyntaxNode[];

// [zkdev] P2: Module-level AST cache — reuse parse results when file content unchanged.
// Key: filepath, Value: { content used for parsing, parsed tree }.
// Evicts LRU when exceeding MAX_AST_CACHE_SIZE.
const MAX_AST_CACHE_SIZE = 20;
const astCache = new Map<string, { content: string; tree: Parser.Tree }>();

export async function getAst(
  filepath: string,
  fileContents: string,
): Promise<Parser.Tree | undefined> {
  // Check cache: same filepath + same content → reuse tree
  const cached = astCache.get(filepath);
  if (cached && cached.content === fileContents) {
    return cached.tree;
  }

  const parser = await getParserForFile(filepath);

  if (!parser) {
    return undefined;
  }

  try {
    const ast = parser.parse(fileContents);

    // Evict oldest entry if at capacity (Map preserves insertion order)
    if (astCache.size >= MAX_AST_CACHE_SIZE) {
      const oldestKey = astCache.keys().next().value;
      if (oldestKey !== undefined) {
        astCache.delete(oldestKey);
      }
    }
    astCache.set(filepath, { content: fileContents, tree: ast });

    return ast;
  } catch (e) {
    return undefined;
  }
}

export async function getTreePathAtCursor(
  ast: Parser.Tree,
  cursorIndex: number,
): Promise<AstPath> {
  const path = [ast.rootNode];
  while (path[path.length - 1].childCount > 0) {
    let foundChild = false;
    for (const child of path[path.length - 1].children) {
      if (child.startIndex <= cursorIndex && child.endIndex >= cursorIndex) {
        path.push(child);
        foundChild = true;
        break;
      }
    }

    if (!foundChild) {
      break;
    }
  }

  return path;
}

export async function getScopeAroundRange(
  range: RangeInFileWithContents,
): Promise<RangeInFileWithContents | undefined> {
  const ast = await getAst(range.filepath, range.contents);
  if (!ast) {
    return undefined;
  }

  const { start: s, end: e } = range.range;
  const lines = range.contents.split("\n");
  const startIndex =
    lines.slice(0, s.line).join("\n").length +
    (lines[s.line]?.slice(s.character).length ?? 0);
  const endIndex =
    lines.slice(0, e.line).join("\n").length +
    (lines[e.line]?.slice(0, e.character).length ?? 0);

  let node = ast.rootNode;
  while (node.childCount > 0) {
    let foundChild = false;
    for (const child of node.children) {
      if (child.startIndex < startIndex && child.endIndex > endIndex) {
        node = child;
        foundChild = true;
        break;
      }
    }

    if (!foundChild) {
      break;
    }
  }

  return {
    contents: node.text,
    filepath: range.filepath,
    range: {
      start: {
        line: node.startPosition.row,
        character: node.startPosition.column,
      },
      end: {
        line: node.endPosition.row,
        character: node.endPosition.column,
      },
    },
  };
}
