/**
 * [zkdev] P0: Predictive Prefetch Service
 *
 * After user accepts a completion, pre-generates the next completion in background.
 * The result is stored in the LRU cache so the next real request is an instant cache hit.
 *
 * Also covers P1 (line-level prefetch): the prefetched completion may span multiple lines,
 * providing coverage for the next few lines of editing.
 */

import Handlebars from "handlebars";
import { ILLM } from "../../index.js";
import { getUriPathBasename } from "../../util/uri.js";
import { postprocessCompletion } from "../postprocessing/index.js";
import { getTemplateForModel } from "../templating/AutocompleteTemplate.js";
import AutocompleteLruCache from "../util/AutocompleteLruCache.js";
import { AutocompleteOutcome } from "../util/types.js";

export class PrefetchService {
  private _abortController: AbortController | null = null;
  private _cache = AutocompleteLruCache.get();

  /**
   * Cancel any in-flight prefetch (e.g., when user starts typing again).
   */
  cancel(): void {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Fire-and-forget: after a completion is accepted, pre-warm the cache
   * for the predicted next cursor position.
   */
  async prefetchAfterAccept(
    outcome: AutocompleteOutcome,
    getLlm: () => Promise<ILLM | undefined>,
  ): Promise<void> {
    if (!outcome.useCache || !outcome.completion) {
      return;
    }

    // Cancel any previous prefetch
    this.cancel();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    try {
      // Wait a small amount for the editor to apply the accepted text
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) return;

      const llm = await getLlm();
      if (!llm || signal.aborted) return;

      // Compute the predicted new document prefix after the completion is inserted
      // Use documentPrefix (raw document text), NOT compiled prompt prefix
      const docPrefix = outcome.documentPrefix ?? outcome.prefix;
      const newPrefix = docPrefix + outcome.completion;

      // Check if already cached
      const cache = await this._cache;
      if (await cache.get(newPrefix)) return;
      if (signal.aborted) return;

      // Use documentSuffix (raw document text), NOT compiled prompt suffix
      const docSuffix = outcome.documentSuffix ?? outcome.suffix;

      // Build a lightweight prompt using the model's template
      const prompt = this._buildPrefetchPrompt(
        newPrefix,
        docSuffix,
        outcome.filepath,
        outcome.modelName,
      );
      if (!prompt || signal.aborted) return;

      // Get template completion options (stop tokens etc.)
      const template = getTemplateForModel(outcome.modelName);

      // Stream completion with tight limits
      let completion = "";
      const stream = llm.streamComplete(prompt, signal, {
        ...template.completionOptions,
        maxTokens: 256, // Tight limit for prefetch
        raw: true,
      });

      for await (const chunk of stream) {
        if (signal.aborted) return;
        completion += chunk;
        // Safety: stop if too long (shouldn't happen with maxTokens but just in case)
        if (completion.length > 2000) break;
      }

      if (signal.aborted || !completion) return;

      // Post-process
      const processed = postprocessCompletion({
        completion,
        prefix: newPrefix,
        suffix: docSuffix,
        llm,
      });

      if (processed) {
        await cache.put(newPrefix, processed);
      }
    } catch {
      // Prefetch is best-effort — silently ignore errors
    } finally {
      this._abortController = null;
    }
  }

  /**
   * Build a FIM prompt for the prefetch using the model's template.
   * Uses a lightweight approach: no snippet collection, just prefix/suffix with FIM tokens.
   */
  private _buildPrefetchPrompt(
    prefix: string,
    suffix: string,
    filepath: string,
    modelName: string,
  ): string | undefined {
    try {
      const template = getTemplateForModel(modelName);

      // For templates with compilePrefixSuffix (multifile templates),
      // call it with empty snippets to get proper FIM wrapping
      let compiledPrefix = prefix;
      let compiledSuffix = suffix;
      const reponame = getUriPathBasename(filepath);

      if (template.compilePrefixSuffix) {
        [compiledPrefix, compiledSuffix] = template.compilePrefixSuffix(
          prefix,
          compiledSuffix,
          filepath,
          reponame,
          [], // no snippets for lightweight prefetch
          [],
        );
      }

      if (typeof template.template === "string") {
        const compiled = Handlebars.compile(template.template);
        return compiled({
          prefix: compiledPrefix,
          suffix: compiledSuffix,
          filename: getUriPathBasename(filepath),
          reponame,
          language: "",
        });
      } else {
        return template.template(
          compiledPrefix,
          compiledSuffix,
          filepath,
          reponame,
          "",
          [],
          [],
        );
      }
    } catch {
      return undefined;
    }
  }
}
