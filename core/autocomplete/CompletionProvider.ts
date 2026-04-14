import { ConfigHandler } from "../config/ConfigHandler.js";
import { IDE, ILLM } from "../index.js";
import OpenAI from "../llm/llms/OpenAI.js";
import { DEFAULT_AUTOCOMPLETE_OPTS } from "../util/parameters.js";

import { shouldCompleteMultiline } from "./classification/shouldCompleteMultiline.js";
import { ContextRetrievalService } from "./context/ContextRetrievalService.js";
import { DefinitionCacheService } from "./context/DefinitionCacheService.js";
import { QueueManager } from "./context/QueueManager.js";

import { isSecurityConcern } from "../indexing/ignore.js";
import { BracketMatchingService } from "./filtering/BracketMatchingService.js";
import { CompletionStreamer } from "./generation/CompletionStreamer.js";
import { postprocessCompletion } from "./postprocessing/index.js";
import { PrefetchService } from "./prediction/PrefetchService.js";
import { SimilarEditDetector } from "./prediction/SimilarEditDetector.js";
import { shouldPrefilter } from "./prefiltering/index.js";
import { SnippetPayload } from "./snippets/getAllSnippets.js";
import { getAllSnippetsWithoutRace } from "./snippets/index.js";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
} from "./snippets/types.js";
import { renderPromptWithTokenLimit } from "./templating/index.js";
import { GetLspDefinitionsFunction } from "./types.js";
import { AutocompleteDebouncer } from "./util/AutocompleteDebouncer.js";
import { AutocompleteLoggingService } from "./util/AutocompleteLoggingService.js";
import AutocompleteLruCache from "./util/AutocompleteLruCache.js";
import { HelperVars } from "./util/HelperVars.js";
import {
  AutocompleteInput,
  AutocompleteOutcome,
  AutocompleteStageTimings,
} from "./util/types.js";

const autocompleteCache = AutocompleteLruCache.get();

// Errors that can be expected on occasion even during normal functioning should not be shown.
// Not worth disrupting the user to tell them that a single autocomplete request didn't go through
const ERRORS_TO_IGNORE = [
  // From Ollama
  "unexpected server status",
  "operation was aborted",
];

export class CompletionProvider {
  private autocompleteCache = AutocompleteLruCache.get();
  public errorsShown: Set<string> = new Set();
  private bracketMatchingService = new BracketMatchingService();
  private debouncer = new AutocompleteDebouncer();
  private completionStreamer: CompletionStreamer;
  private loggingService = new AutocompleteLoggingService();
  private contextRetrievalService: ContextRetrievalService;
  private prefetchService = new PrefetchService();
  private similarEditDetector = new SimilarEditDetector();
  private definitionCacheService: DefinitionCacheService;

  constructor(
    private readonly configHandler: ConfigHandler,
    private readonly ide: IDE,
    private readonly _injectedGetLlm: () => Promise<ILLM | undefined>,
    private readonly _onError: (e: any) => void,
    private readonly getDefinitionsFromLsp: GetLspDefinitionsFunction,
    private readonly queueManager?: QueueManager,
  ) {
    this.completionStreamer = new CompletionStreamer(this.onError.bind(this));
    this.contextRetrievalService = new ContextRetrievalService(this.ide);
    this.definitionCacheService = new DefinitionCacheService(this.ide);
  }

  private async _prepareLlm(): Promise<ILLM | undefined> {
    const llm = await this._injectedGetLlm();

    if (!llm) {
      return undefined;
    }

    // Temporary fix for JetBrains autocomplete bug as described in https://github.com/continuedev/continue/pull/3022
    if (llm.model === undefined && llm.completionOptions?.model !== undefined) {
      llm.model = llm.completionOptions.model;
    }

    // Ignore empty API keys for Mistral since we currently write
    // a template provider without one during onboarding
    if (llm.providerName === "mistral" && llm.apiKey === "") {
      return undefined;
    }

    // [zkdev] Default temperature=0 for deterministic output → better cache hit rate
    // User can override via tabAutocompleteOptions.completionOptions.temperature in config
    if (llm.completionOptions.temperature === undefined) {
      llm.completionOptions.temperature = 0;
    }

    if (llm instanceof OpenAI && llm.providerName !== "openrouter") {
      llm.useLegacyCompletionsEndpoint = true;
    }

    return llm;
  }

  private onError(e: any) {
    if (
      ERRORS_TO_IGNORE.some((err) =>
        typeof e === "string" ? e.includes(err) : e?.message?.includes(err),
      )
    ) {
      return;
    }

    console.warn("Error generating autocompletion: ", e);
    if (!this.errorsShown.has(e.message)) {
      this.errorsShown.add(e.message);
      this._onError(e);
    }
  }

  public cancel() {
    this.loggingService.cancel();
    this.prefetchService.cancel();
  }

  /**
   * Warm imports for a file: init import definitions cache, then push results to importQueue.
   * Called from IDE adapter on tab switch. Non-blocking.
   */
  public async warmFile(filepath: string, signal?: AbortSignal): Promise<void> {
    if (!this.queueManager) {
      return;
    }

    try {
      // Wait for ImportDefinitionsService to resolve for this file
      await this.contextRetrievalService.initializeForFile(filepath);

      if (signal?.aborted) {
        return;
      }

      // [zkdev] P1-7/8: Warm DefinitionCacheService by scanning file for function defs
      try {
        const content = await this.ide.readFile(filepath);
        if (content && !signal?.aborted) {
          this.definitionCacheService.warmFile(filepath, content);
        }
      } catch {
        // Non-critical
      }

      // Extract import definitions and push to importQueue
      const importDefs =
        this.contextRetrievalService.getImportDefinitionsForFile(filepath);
      for (const def of importDefs) {
        if (signal?.aborted) {
          return;
        }
        this.queueManager.pushImportDef(
          def.defFilepath,
          def.content,
          def.startLine,
          def.endLine,
        );
      }

      // Mark full-ready (imports are now populated)
      this.queueManager.markFullReady(filepath);
    } catch (e) {
      console.warn(`[QueueManager] Import warming failed for ${filepath}:`, e);
    }
  }

  public accept(completionId: string) {
    const outcome = this.loggingService.accept(completionId);
    if (!outcome) {
      return;
    }
    this.bracketMatchingService.handleAcceptedCompletion(
      outcome.completion,
      outcome.filepath,
    );
    // [zkdev] P0: Predictive prefetch — pre-generate next completion in background
    // Gated behind experimental_enablePrefetch flag (default off)
    if (outcome.experimental_enablePrefetch) {
      this.prefetchService
        .prefetchAfterAccept(outcome, this._prepareLlm.bind(this))
        .catch(() => {});
    }
    // [zkdev] P3: Record edit for similar edit pattern detection + pre-populate cache
    // Gated behind experimental_enableSimilarEditDetection flag (default off)
    if (outcome.experimental_enableSimilarEditDetection) {
      this.similarEditDetector.recordEdit(outcome);
      this._cacheSimlarEditPredictions(outcome).catch(() => {});
    }
  }

  // [zkdev] P3: When similar edit pattern detected, pre-populate cache for predicted locations
  private async _cacheSimlarEditPredictions(
    outcome: AutocompleteOutcome,
  ): Promise<void> {
    if (!outcome.useCache) return;
    try {
      // Use documentPrefix/Suffix (raw document text), NOT compiled prompt prefix
      const fileContent =
        outcome.documentPrefix + outcome.completion + outcome.documentSuffix;
      const predictions = this.similarEditDetector.detectSimilarLocations(
        fileContent,
        outcome.filepath,
      );
      if (predictions.length === 0) return;

      const cache = await this.autocompleteCache;
      for (const pred of predictions) {
        // Only cache if not already present
        if (!(await cache.get(pred.predictedPrefix))) {
          await cache.put(pred.predictedPrefix, pred.predictedCompletion);
        }
      }
    } catch {
      // P3 is best-effort
    }
  }

  public markDisplayed(completionId: string, outcome: AutocompleteOutcome) {
    this.loggingService.markDisplayed(completionId, outcome);
  }

  private async _getAutocompleteOptions(llm: ILLM) {
    const { config } = await this.configHandler.loadConfig();
    const options = {
      ...DEFAULT_AUTOCOMPLETE_OPTS,
      ...config?.tabAutocompleteOptions,
      ...llm.autocompleteOptions,
    };

    // Enable static contextualization if defined.
    if (config?.experimental?.enableStaticContextualization) {
      options.experimental_enableStaticContextualization = true;
    }

    return options;
  }

  /**
   * Inject project-internal function definitions + scope summary into snippet payload.
   * Extracted to reduce provideInlineCompletionItems complexity.
   */
  private async enrichSnippetPayload(
    snippetPayload: SnippetPayload,
    helper: HelperVars,
    completionId: string,
  ): Promise<void> {
    // P1-7/8: Inject project-internal function definition context
    try {
      const defSnippets =
        await this.definitionCacheService.getDefinitionsForContext(
          helper.fullPrefix,
          helper.fullSuffix,
          helper.filepath,
          helper.workspaceUris,
          300,
        );
      if (defSnippets.length > 0) {
        snippetPayload.importDefinitionSnippets = [
          ...snippetPayload.importDefinitionSnippets,
          ...defSnippets,
        ];
        console.log(
          `[Autocomplete DefinitionCache] completionId=${completionId} ` +
            `defs=${defSnippets.length}`,
        );
      }
    } catch (e) {
      // Non-critical, don't block completion
    }

    // Inject scope summary (class method signatures + call target defs)
    const scopeSnippet = helper.getScopeSummarySnippet();
    if (scopeSnippet) {
      const scopeCodeSnippet: AutocompleteCodeSnippet = {
        filepath: scopeSnippet.filepath,
        content: scopeSnippet.content,
        type: AutocompleteSnippetType.Code,
      };
      snippetPayload.rootPathSnippets = [
        scopeCodeSnippet,
        ...snippetPayload.rootPathSnippets,
      ];
      console.log(
        `[Autocomplete ScopeSummary] completionId=${completionId} ` +
          `contentLen=${scopeSnippet.content.length}`,
      );
    }
  }

  /**
   * Ensure QueueManager is warmed for this file: proactive warm + synthesize visitedRange.
   * Extracted to reduce provideInlineCompletionItems complexity.
   */
  private _ensureQueueWarmed(
    input: AutocompleteInput,
    helper: HelperVars,
  ): void {
    if (!this.queueManager) return;

    // Proactive warm: if file not yet warmed, push header from already-read fileLines
    if (!this.queueManager.isReady(input.filepath)) {
      const headerEnd = Math.min(30, helper.fileLines.length);
      const headerContent = helper.fileLines.slice(0, headerEnd).join("\n");
      this.queueManager.pushOpenedFile(
        input.filepath,
        headerContent,
        0,
        headerEnd,
      );
      this.queueManager.markCoreReady(input.filepath);
      const controller = this.queueManager.startWarming(input.filepath);
      this.warmFile(input.filepath, controller.signal).catch(() => {});
      console.log(
        `[QueueManager ProactiveWarm] Warmed ${input.filepath} from autocomplete request`,
      );
    }

    // Synthesize visitedRange from cursor position (±15 lines)
    const cursorLine = input.pos.line;
    const visitStart = Math.max(0, cursorLine - 15);
    const visitEnd = Math.min(helper.fileLines.length, cursorLine + 16);
    const visitContent = helper.fileLines
      .slice(visitStart, visitEnd)
      .join("\n");
    if (visitContent.trim().length > 0) {
      this.queueManager.pushVisited(
        input.filepath,
        visitContent,
        visitStart,
        visitEnd,
      );
    }
  }

  public async provideInlineCompletionItems(
    input: AutocompleteInput,
    token: AbortSignal | undefined,
    force?: boolean,
  ): Promise<AutocompleteOutcome | undefined> {
    try {
      // Create abort signal if not given
      if (!token) {
        const controller = this.loggingService.createAbortController(
          input.completionId,
        );
        token = controller.signal;
      }
      const startTime = Date.now();

      const llm = await this._prepareLlm();
      const afterPrepareLlm = Date.now();
      if (!llm) {
        return undefined;
      }

      if (isSecurityConcern(input.filepath)) {
        return undefined;
      }
      const afterSecurityCheck = Date.now();

      const options = await this._getAutocompleteOptions(llm);
      const afterGetAutocompleteOptions = Date.now();

      const beforeDebounce = Date.now();

      // Debounce
      if (!force) {
        if (
          await this.debouncer.delayAndShouldDebounce(options.debounceDelay)
        ) {
          return undefined;
        }
      }
      const afterDebounce = Date.now();

      console.log(
        `[Autocomplete Debounce SubTimings] completionId=${input.completionId} ` +
          `prepareLlmMs=${afterPrepareLlm - startTime} ` +
          `securityCheckMs=${afterSecurityCheck - afterPrepareLlm} ` +
          `getOptionsMs=${afterGetAutocompleteOptions - afterSecurityCheck} ` +
          `debounceWaitMs=${afterDebounce - beforeDebounce} ` +
          `totalPreDebounceMs=${afterDebounce - startTime}`,
      );

      if (llm.promptTemplates?.autocomplete) {
        options.template = llm.promptTemplates.autocomplete as string;
      }

      const beforeCreate = Date.now();
      const helper = await HelperVars.create(
        input,
        options,
        llm.model,
        this.ide,
      );
      const afterHelperVars = Date.now();
      // [zkdev] Diagnostic: isolate gap between afterDebounce, beforeCreate, and afterHelperVars
      console.log(
        `[Autocomplete HelperVarsGap] completionId=${input.completionId} ` +
          `logOverheadMs=${beforeCreate - afterDebounce} ` +
          `createExternalMs=${afterHelperVars - beforeCreate} ` +
          `helperVarsMs=${afterHelperVars - afterDebounce}`,
      );

      // [zkdev] Proactive warm + visitedRange synthesis (extracted to reduce complexity)
      this._ensureQueueWarmed(input, helper);

      if (await shouldPrefilter(helper, this.ide)) {
        return undefined;
      }
      const afterPrefilter = Date.now();

      // [zkdev] Local SQLite cache DISABLED — sglang prefix cache handles caching at GPU level.
      // Keeping code for reference; uncomment to re-enable.
      // const cache = await autocompleteCache;
      // const cachedCompletion = helper.options.useCache
      //   ? await cache.get(helper.prunedPrefix)
      //   : undefined;
      const afterCacheCheck = Date.now();

      // [zkdev] Cache fast-path DISABLED — all completions go through LLM.
      // To re-enable: uncomment cache check above, restore if (cachedCompletion) block.
      /*
      if (cachedCompletion) {
        // Cache hit fast-path: skip context collection and prompt building entirely
        const afterPostProcess = Date.now();
        const stageTimings: AutocompleteStageTimings = {
          prepareLlmMs: afterPrepareLlm - startTime,
          debounceMs: afterDebounce - afterPrepareLlm,
          contextCollectionMs: 0,
          promptBuildMs: 0,
          streamCompletionMs: 0,
          postProcessMs: afterPostProcess - afterDebounce,
        };

        const outcome: AutocompleteOutcome = {
          time: Date.now() - startTime,
          stageTimings,
          completion: cachedCompletion,
          prefix: helper.prunedPrefix,
          suffix: helper.prunedSuffix,
          documentPrefix: helper.prunedPrefix,
          documentSuffix: helper.prunedSuffix,
          prompt: "",
          modelProvider: llm.underlyingProviderName,
          modelName: llm.model,
          completionOptions: {},
          cacheHit: true,
          filepath: helper.filepath,
          numLines: cachedCompletion.split("\n").length,
          completionId: helper.input.completionId,
          gitRepo: await this.ide.getRepoName(helper.filepath),
          uniqueId: await this.ide.getUniqueId(),
          timestamp: new Date().toISOString(),
          profileType:
            this.configHandler.currentProfile?.profileDescription.profileType,
          ...helper.options,
        };

        const ideType = (await this.ide.getIdeInfo()).ideType;
        if (ideType === "jetbrains") {
          this.markDisplayed(input.completionId, outcome);
        }

        return outcome;
      }
      */

      // [zkdev] Phase 3: Use QueueManager when available and file is ready,
      // otherwise fall back to existing getAllSnippetsWithoutRace path.
      let snippetPayload;
      let usedFastPath = false;
      if (this.queueManager && this.queueManager.isReady(input.filepath)) {
        // Queue-based fast path: snippets already collected by event-driven push
        // Skip expensive IPC operations (getRootPathSnippets, enrichSnippetPayload)
        // to achieve <30ms context collection
        const queuePayload = this.queueManager.toSnippetPayload(
          helper.options.maxPromptTokens ?? 2000,
        );
        // [zkdev] Skip rootPathSnippets in fast path - it requires gotoDefinition IPC (~150ms)
        // The scopeSummary from enrichSnippetPayload is still added if available locally
        const scopeSnippet = helper.getScopeSummarySnippet();
        const rootPathSnippets: AutocompleteCodeSnippet[] = scopeSnippet
          ? [
              {
                filepath: scopeSnippet.filepath,
                content: scopeSnippet.content,
                type: AutocompleteSnippetType.Code,
              },
            ]
          : [];
        snippetPayload = {
          rootPathSnippets,
          ideSnippets: [],
          clipboardSnippets: [],
          staticSnippet: [],
          ...queuePayload,
        };
        usedFastPath = true;
        console.log(
          `[Autocomplete IntelliJ Sequence] ${input.completionId} completion-provider.snippets queue-fast-path`,
        );
      } else {
        // Legacy path: collect snippets on-demand
        snippetPayload = await getAllSnippetsWithoutRace({
          helper,
          ide: this.ide,
          getDefinitionsFromLsp: this.getDefinitionsFromLsp,
          contextRetrievalService: this.contextRetrievalService,
        });

        // [zkdev] Phase 1.3: Backfill QueueManager from legacy results so next request uses fast path
        if (this.queueManager && !this.queueManager.isReady(input.filepath)) {
          for (const s of snippetPayload.recentlyOpenedFileSnippets ?? []) {
            this.queueManager.pushOpenedFile(
              s.filepath,
              s.content,
              s.startLine ?? 0,
              s.endLine ?? 0,
            );
          }
          for (const s of snippetPayload.importDefinitionSnippets ?? []) {
            this.queueManager.pushImportDef(
              s.filepath,
              s.content,
              s.startLine ?? 0,
              s.endLine ?? 0,
            );
          }
          this.queueManager.markCoreReady(input.filepath);
          this.queueManager.markFullReady(input.filepath);
          console.log(
            `[QueueManager Backfill] Populated from legacy path for ${input.filepath}`,
          );
        }
        console.log(
          `[Autocomplete IntelliJ Sequence] ${input.completionId} completion-provider.snippets legacy-path`,
        );
      }

      // [zkdev] P1-7/8 + scope summary: enrich snippet payload with definitions & scope
      // Skip in fast-path since import definitions are already in queue,
      // and scopeSummary was already added above
      if (!usedFastPath) {
        await this.enrichSnippetPayload(
          snippetPayload,
          helper,
          input.completionId,
        );
      }

      const workspaceDirs = helper.workspaceUris;
      const afterContextCollection = Date.now();

      // [zkdev] Sub-timing breakdown for context_collection diagnosis
      console.log(
        `[Autocomplete SubTimings] completionId=${input.completionId} ` +
          `helperVarsMs=${afterHelperVars - afterDebounce} ` +
          `prefilterMs=${afterPrefilter - afterHelperVars} ` +
          `cacheCheckMs=${afterCacheCheck - afterPrefilter} ` +
          `snippetCollectionMs=${afterContextCollection - afterCacheCheck} ` +
          `totalContextMs=${afterContextCollection - afterDebounce}`,
      );

      const { prompt, prefix, suffix, completionOptions } =
        renderPromptWithTokenLimit({
          snippetPayload,
          workspaceDirs,
          helper,
          llm,
        });

      const afterPromptBuild = Date.now();

      // [zkdev] Log completionOptions for debugging
      console.log(
        `[Autocomplete Options] completionId=${input.completionId} ` +
          `maxTokens=${completionOptions?.maxTokens} stop=${JSON.stringify(completionOptions?.stop)}`,
      );

      // Completion
      let completion: string | undefined = "";

      let afterStreamCompletion = afterPromptBuild;
      {
        const multiline =
          !helper.options.transform || shouldCompleteMultiline(helper);

        const completionStream =
          this.completionStreamer.streamCompletionWithFilters(
            token,
            llm,
            prefix,
            suffix,
            prompt,
            multiline,
            completionOptions,
            helper,
          );

        for await (const update of completionStream) {
          completion += update;
        }
        afterStreamCompletion = Date.now();

        // [zkdev] Diagnostic: raw stream result before any filtering
        console.log(
          `[Autocomplete StreamRaw] completionId=${input.completionId} rawLen=${completion?.length ?? 0} streamMs=${afterStreamCompletion - afterPromptBuild}`,
        );

        // Don't postprocess if aborted
        if (token.aborted) {
          console.log(
            `[Autocomplete Aborted] completionId=${input.completionId} rawLen=${completion?.length ?? 0}`,
          );
          return undefined;
        }

        const processedCompletion = helper.options.transform
          ? postprocessCompletion({
              completion,
              prefix: helper.prunedPrefix,
              suffix: helper.prunedSuffix,
              llm,
            })
          : completion;

        completion = processedCompletion;
      }
      const afterPostProcess = Date.now();

      if (!completion) {
        console.log(
          `[Autocomplete EmptyResult] completionId=${input.completionId} postProcessMs=${afterPostProcess - afterStreamCompletion}`,
        );
        return undefined;
      }

      // [zkdev] Log the final completion result
      console.log(
        `[Autocomplete Result] completionId=${input.completionId} ` +
          `totalMs=${Date.now() - startTime} completionLen=${completion.length}\n` +
          `--- COMPLETION START ---\n${completion}\n--- COMPLETION END ---`,
      );

      const stageTimings: AutocompleteStageTimings = {
        prepareLlmMs: afterPrepareLlm - startTime,
        debounceMs: afterDebounce - afterPrepareLlm,
        contextCollectionMs: afterContextCollection - afterDebounce,
        promptBuildMs: afterPromptBuild - afterContextCollection,
        streamCompletionMs: afterStreamCompletion - afterPromptBuild,
        postProcessMs: afterPostProcess - afterStreamCompletion,
      };

      const outcome: AutocompleteOutcome = {
        time: Date.now() - startTime,
        stageTimings,
        completion,
        prefix,
        suffix,
        documentPrefix: helper.prunedPrefix,
        documentSuffix: helper.prunedSuffix,
        prompt,
        modelProvider: llm.underlyingProviderName,
        modelName: llm.model,
        completionOptions,
        cacheHit: false,
        filepath: helper.filepath,
        numLines: completion.split("\n").length,
        completionId: helper.input.completionId,
        gitRepo: await this.ide.getRepoName(helper.filepath),
        uniqueId: await this.ide.getUniqueId(),
        timestamp: new Date().toISOString(),
        profileType:
          this.configHandler.currentProfile?.profileDescription.profileType,
        ...helper.options,
      };

      if (options.experimental_enableStaticContextualization) {
        outcome.enabledStaticContextualization = true;
      }

      //////////

      // [zkdev] Local SQLite cache DISABLED — writes also disabled.
      // Sglang prefix cache handles caching at GPU level.
      // if (!outcome.cacheHit && helper.options.useCache) {
      //   (await this.autocompleteCache)
      //     .put(outcome.documentPrefix, outcome.completion)
      //     .catch((e) => console.warn(`Failed to save to cache: ${e.message}`));
      // }

      // When using the JetBrains extension, Mark as displayed
      const ideType = (await this.ide.getIdeInfo()).ideType;
      if (ideType === "jetbrains") {
        this.markDisplayed(input.completionId, outcome);
      }

      return outcome;
    } catch (e: any) {
      this.onError(e);
    } finally {
      this.loggingService.deleteAbortController(input.completionId);
    }
  }
}
