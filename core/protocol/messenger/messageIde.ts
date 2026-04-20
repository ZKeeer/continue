import { FromIdeProtocol } from "..";
import { ToIdeFromWebviewOrCoreProtocol } from "../ide";

import type {
  DocumentSymbol,
  FileStatsMap,
  FileType,
  IDE,
  IdeInfo,
  IdeSettings,
  IndexTag,
  Location,
  Position,
  Problem,
  Range,
  RangeInFile,
  SignatureHelp,
  TerminalOptions,
  Thread,
} from "../..";

export class MessageIde implements IDE {
  private _ideInfoCache: IdeInfo | undefined;
  private _ideInfoPromise: Promise<IdeInfo> | undefined;
  private _workspaceDirsCache: string[] | undefined;
  private _workspaceDirsTimestamp = 0;
  private _workspaceDirsPromise: Promise<string[]> | undefined;
  private static readonly WORKSPACE_DIRS_TTL_MS = 30_000;
  private _repoNameCache = new Map<
    string,
    { name: string | undefined; timestamp: number }
  >();
  private static readonly REPO_NAME_TTL_MS = 60_000;

  // [zkdev] Additional caches for static/semi-static IDE requests
  private _ideSettingsCache:
    | { settings: IdeSettings; timestamp: number }
    | undefined;
  private static readonly IDE_SETTINGS_TTL_MS = 60_000; // Settings may change
  private _telemetryEnabledCache: boolean | undefined;
  private _isRemoteCache: boolean | undefined;
  private _uniqueIdCache: string | undefined;
  private _gitRootPathCache = new Map<string, string | undefined>();
  private _branchCache = new Map<
    string,
    { branch: string; timestamp: number }
  >();
  private static readonly BRANCH_TTL_MS = 10_000; // Branch can change, short TTL

  constructor(
    private readonly request: <T extends keyof ToIdeFromWebviewOrCoreProtocol>(
      messageType: T,
      data: ToIdeFromWebviewOrCoreProtocol[T][0],
    ) => Promise<ToIdeFromWebviewOrCoreProtocol[T][1]>,
    private readonly on: <T extends keyof FromIdeProtocol>(
      messageType: T,
      callback: (data: FromIdeProtocol[T][0]) => FromIdeProtocol[T][1],
    ) => void,
  ) {}

  async readSecrets(keys: string[]): Promise<Record<string, string>> {
    return this.request("readSecrets", { keys });
  }

  async writeSecrets(secrets: { [key: string]: string }): Promise<void> {
    return this.request("writeSecrets", { secrets });
  }

  fileExists(fileUri: string): Promise<boolean> {
    return this.request("fileExists", { filepath: fileUri });
  }

  async gotoDefinition(location: Location): Promise<RangeInFile[]> {
    return this.request("gotoDefinition", { location });
  }

  async gotoTypeDefinition(location: Location): Promise<RangeInFile[]> {
    return this.request("gotoTypeDefinition", { location });
  }

  async getSignatureHelp(location: Location): Promise<SignatureHelp | null> {
    return this.request("getSignatureHelp", { location });
  }

  async getReferences(location: Location): Promise<RangeInFile[]> {
    return this.request("getReferences", { location });
  }

  async getDocumentSymbols(
    textDocumentIdentifier: string,
  ): Promise<DocumentSymbol[]> {
    return this.request("getDocumentSymbols", { textDocumentIdentifier });
  }

  async renameSymbol(params: {
    filepath: string;
    position: Position;
    newName: string;
  }): Promise<{ success: boolean; filesChanged?: number; error?: string }> {
    return this.request("renameSymbol", params);
  }

  onDidChangeActiveTextEditor(callback: (fileUri: string) => void): void {
    this.on("didChangeActiveTextEditor", (data) => callback(data.filepath));
  }

  getIdeSettings(): Promise<IdeSettings> {
    if (
      this._ideSettingsCache &&
      Date.now() - this._ideSettingsCache.timestamp <
        MessageIde.IDE_SETTINGS_TTL_MS
    ) {
      return Promise.resolve(this._ideSettingsCache.settings);
    }
    return this.request("getIdeSettings", undefined).then((settings) => {
      this._ideSettingsCache = { settings, timestamp: Date.now() };
      return settings;
    });
  }

  getFileStats(files: string[]): Promise<FileStatsMap> {
    return this.request("getFileStats", { files });
  }
  getGitRootPath(dir: string): Promise<string | undefined> {
    if (this._gitRootPathCache.has(dir)) {
      return Promise.resolve(this._gitRootPathCache.get(dir));
    }
    return this.request("getGitRootPath", { dir }).then((root) => {
      this._gitRootPathCache.set(dir, root);
      return root;
    });
  }

  listDir(dir: string): Promise<[string, FileType][]> {
    return this.request("listDir", { dir });
  }

  showToast: IDE["showToast"] = (...params) => {
    return this.request("showToast", params);
  };

  getRepoName(dir: string): Promise<string | undefined> {
    const cached = this._repoNameCache.get(dir);
    if (cached && Date.now() - cached.timestamp < MessageIde.REPO_NAME_TTL_MS) {
      return Promise.resolve(cached.name);
    }
    return this.request("getRepoName", { dir }).then((name) => {
      this._repoNameCache.set(dir, { name, timestamp: Date.now() });
      return name;
    });
  }

  getDebugLocals(threadIndex: number): Promise<string> {
    return this.request("getDebugLocals", { threadIndex });
  }

  getTopLevelCallStackSources(
    threadIndex: number,
    stackDepth: number,
  ): Promise<string[]> {
    return this.request("getTopLevelCallStackSources", {
      threadIndex,
      stackDepth,
    });
  }

  getAvailableThreads(): Promise<Thread[]> {
    return this.request("getAvailableThreads", undefined);
  }

  getTags(artifactId: string): Promise<IndexTag[]> {
    return this.request("getTags", artifactId);
  }

  getIdeInfo(): Promise<IdeInfo> {
    if (this._ideInfoCache) {
      return Promise.resolve(this._ideInfoCache);
    }
    if (this._ideInfoPromise) {
      return this._ideInfoPromise;
    }
    this._ideInfoPromise = this.request("getIdeInfo", undefined).then(
      (info) => {
        this._ideInfoCache = info;
        this._ideInfoPromise = undefined;
        return info;
      },
    );
    return this._ideInfoPromise;
  }

  readRangeInFile(filepath: string, range: Range): Promise<string> {
    return this.request("readRangeInFile", { filepath, range });
  }

  isTelemetryEnabled(): Promise<boolean> {
    if (this._telemetryEnabledCache !== undefined) {
      return Promise.resolve(this._telemetryEnabledCache);
    }
    return this.request("isTelemetryEnabled", undefined).then((enabled) => {
      this._telemetryEnabledCache = enabled;
      return enabled;
    });
  }

  isWorkspaceRemote(): Promise<boolean> {
    if (this._isRemoteCache !== undefined) {
      return Promise.resolve(this._isRemoteCache);
    }
    return this.request("isWorkspaceRemote", undefined).then((isRemote) => {
      this._isRemoteCache = isRemote;
      return isRemote;
    });
  }

  getUniqueId(): Promise<string> {
    if (this._uniqueIdCache) {
      return Promise.resolve(this._uniqueIdCache);
    }
    return this.request("getUniqueId", undefined).then((id) => {
      this._uniqueIdCache = id;
      return id;
    });
  }

  async getDiff(includeUnstaged: boolean) {
    return await this.request("getDiff", { includeUnstaged });
  }

  async getClipboardContent(): Promise<{ text: string; copiedAt: string }> {
    return {
      text: "",
      copiedAt: new Date().toISOString(),
    };
  }

  async getTerminalContents() {
    return await this.request("getTerminalContents", undefined);
  }

  async getWorkspaceDirs(): Promise<string[]> {
    const now = Date.now();
    if (
      this._workspaceDirsCache &&
      now - this._workspaceDirsTimestamp < MessageIde.WORKSPACE_DIRS_TTL_MS
    ) {
      return this._workspaceDirsCache;
    }
    if (this._workspaceDirsPromise) {
      return this._workspaceDirsPromise;
    }
    this._workspaceDirsPromise = this.request(
      "getWorkspaceDirs",
      undefined,
    ).then((dirs) => {
      this._workspaceDirsCache = dirs;
      this._workspaceDirsTimestamp = Date.now();
      this._workspaceDirsPromise = undefined;
      return dirs;
    });
    return this._workspaceDirsPromise;
  }

  async showLines(
    fileUri: string,
    startLine: number,
    endLine: number,
  ): Promise<void> {
    return await this.request("showLines", {
      filepath: fileUri,
      startLine,
      endLine,
    });
  }

  async writeFile(fileUri: string, contents: string): Promise<void> {
    await this.request("writeFile", { path: fileUri, contents });
  }

  async removeFile(fileUri: string): Promise<void> {
    await this.request("removeFile", { path: fileUri });
  }

  async showVirtualFile(title: string, contents: string): Promise<void> {
    await this.request("showVirtualFile", { name: title, content: contents });
  }

  async openFile(fileUri: string): Promise<void> {
    await this.request("openFile", { path: fileUri });
  }

  async openUrl(url: string): Promise<void> {
    await this.request("openUrl", url);
  }

  async runCommand(command: string, options?: TerminalOptions): Promise<void> {
    await this.request("runCommand", { command, options });
  }

  async saveFile(fileUri: string): Promise<void> {
    await this.request("saveFile", { filepath: fileUri });
  }

  async readFile(fileUri: string): Promise<string> {
    return await this.request("readFile", { filepath: fileUri });
  }

  getOpenFiles(): Promise<string[]> {
    return this.request("getOpenFiles", undefined);
  }

  getCurrentFile() {
    return this.request("getCurrentFile", undefined);
  }

  getPinnedFiles(): Promise<string[]> {
    return this.request("getPinnedFiles", undefined);
  }

  getSearchResults(query: string, maxResults?: number): Promise<string> {
    return this.request("getSearchResults", { query, maxResults });
  }

  getFileResults(pattern: string): Promise<string[]> {
    return this.request("getFileResults", { pattern });
  }

  getProblems(fileUri: string): Promise<Problem[]> {
    return this.request("getProblems", { filepath: fileUri });
  }

  subprocess(command: string, cwd?: string): Promise<[string, string]> {
    return this.request("subprocess", { command, cwd });
  }

  async getBranch(dir: string): Promise<string> {
    const cached = this._branchCache.get(dir);
    if (cached && Date.now() - cached.timestamp < MessageIde.BRANCH_TTL_MS) {
      return cached.branch;
    }
    return this.request("getBranch", { dir }).then((branch) => {
      this._branchCache.set(dir, { branch, timestamp: Date.now() });
      return branch;
    });
  }
}
