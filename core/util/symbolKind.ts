// Runtime SymbolKind enum — mirrors the declaration in core/index.d.ts.
// The .d.ts file is type-only (no JS output), so we need a .ts source
// to make the enum importable at runtime.
//
// See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind.
// Values shifted one index down to match vscode.SymbolKind.
export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}
