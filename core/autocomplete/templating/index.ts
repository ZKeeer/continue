import Handlebars from "handlebars";

import { CompletionOptions } from "../..";
import { AutocompleteLanguageInfo } from "../constants/AutocompleteLanguageInfo";
import { HelperVars } from "../util/HelperVars";

import { ILLM } from "../../index.js";
import {
  estimateTokensFast,
  getTokenCountingBufferSafety,
  pruneLinesFromBottomFast,
  pruneLinesFromTopFast,
} from "../../llm/countTokens";
import { getUriPathBasename } from "../../util/uri";
import { SnippetPayload } from "../snippets";
import { AutocompleteSnippet } from "../snippets/types";
import {
  AutocompleteTemplate,
  getTemplateForModel,
} from "./AutocompleteTemplate";
import { FIM_CONTEXT_LABEL, getSnippets } from "./filtering";
import { formatSnippets } from "./formatting";
import { getStopTokens } from "./getStopTokens";

// [zkdev] P2: Autocomplete completions typically need 50-150 tokens.
// Capping at 256 reduces sglang KV cache preallocation per request.
const AUTOCOMPLETE_MAX_TOKENS = 256;

function getTemplate(helper: HelperVars): AutocompleteTemplate {
  if (helper.options.template) {
    return {
      template: helper.options.template,
      completionOptions: {},
      compilePrefixSuffix: undefined,
    };
  }
  return getTemplateForModel(helper.modelName);
}

function renderStringTemplate(
  template: string,
  prefix: string,
  suffix: string,
  lang: AutocompleteLanguageInfo,
  filepath: string,
  reponame: string,
) {
  const filename = getUriPathBasename(filepath);
  const compiledTemplate = Handlebars.compile(template);

  return compiledTemplate({
    prefix,
    suffix,
    filename,
    reponame,
    language: lang.name,
  });
}

/** Consolidates shared setup between renderPrompt and renderPromptWithTokenLimit. */
function preparePromptContext({
  snippetPayload,
  workspaceDirs,
  helper,
}: {
  snippetPayload: SnippetPayload;
  workspaceDirs: string[];
  helper: HelperVars;
}): {
  prefix: string;
  suffix: string;
  reponame: string;
  template: AutocompleteTemplate["template"];
  compilePrefixSuffix: AutocompleteTemplate["compilePrefixSuffix"] | undefined;
  completionOptions: Partial<CompletionOptions> | undefined;
  snippets: AutocompleteSnippet[];
} {
  // Determine base prefix/suffix, accounting for any manually supplied prefix.
  let prefix = helper.input.manuallyPassPrefix || helper.prunedPrefix;
  let suffix = helper.input.manuallyPassPrefix ? "" : helper.prunedSuffix;
  if (suffix === "") {
    suffix = "\n";
  }

  const reponame = getUriPathBasename(workspaceDirs[0] ?? "myproject");

  const { template, compilePrefixSuffix, completionOptions } =
    getTemplate(helper);

  const snippets = getSnippets(helper, snippetPayload);

  return {
    prefix,
    suffix,
    reponame,
    template,
    compilePrefixSuffix,
    completionOptions,
    snippets,
  };
}

export function renderPrompt({
  snippetPayload,
  workspaceDirs,
  helper,
}: {
  snippetPayload: SnippetPayload;
  workspaceDirs: string[];
  helper: HelperVars;
}): {
  prompt: string;
  prefix: string;
  suffix: string;
  completionOptions: Partial<CompletionOptions> | undefined;
} {
  const {
    prefix,
    suffix,
    reponame,
    template,
    compilePrefixSuffix,
    completionOptions,
    snippets,
  } = preparePromptContext({ snippetPayload, workspaceDirs, helper });

  // Delegate prompt construction to buildPrompt to avoid duplication.
  const {
    prompt,
    prefix: compiledPrefix,
    suffix: compiledSuffix,
  } = buildPrompt(
    template,
    compilePrefixSuffix,
    prefix,
    suffix,
    helper,
    snippets,
    workspaceDirs,
    reponame,
  );

  const stopTokens = getStopTokens(
    completionOptions,
    helper.lang,
    helper.modelName,
  );

  return {
    prompt,
    prefix: compiledPrefix,
    suffix: compiledSuffix,
    completionOptions: {
      maxTokens: AUTOCOMPLETE_MAX_TOKENS,
      ...completionOptions,
      stop: stopTokens,
    },
  };
}

/** Builds the final prompt by applying prefix/suffix compilation or snippet formatting, then rendering the template. */
function buildPrompt(
  template: AutocompleteTemplate["template"],
  compilePrefixSuffix: AutocompleteTemplate["compilePrefixSuffix"] | undefined,
  prefix: string,
  suffix: string,
  helper: HelperVars,
  snippets: AutocompleteSnippet[],
  workspaceDirs: string[],
  reponame: string,
): { prompt: string; prefix: string; suffix: string } {
  // [zkdev] FIM context annotation: prepend to current file prefix so the LLM
  // understands the code role before seeing it. Uses language-specific comment mark.
  const fimAnnotation = `${helper.lang.singleLineComment} --- ${FIM_CONTEXT_LABEL} ---`;
  prefix = `${fimAnnotation}\n${prefix}`;

  if (compilePrefixSuffix) {
    [prefix, suffix] = compilePrefixSuffix(
      prefix,
      suffix,
      helper.filepath,
      reponame,
      snippets,
      helper.workspaceUris,
    );
  } else {
    const formatted = formatSnippets(helper, snippets, workspaceDirs);
    prefix = [formatted, prefix].join("\n");
  }
  const prompt =
    typeof template === "string"
      ? renderStringTemplate(
          template,
          prefix,
          suffix,
          helper.lang,
          helper.filepath,
          reponame,
        )
      : template(
          prefix,
          suffix,
          helper.filepath,
          reponame,
          helper.lang.name,
          snippets,
          helper.workspaceUris,
        );
  return { prompt, prefix, suffix };
}

function pruneLength(llm: ILLM, prompt: string): number {
  const contextLength = llm.contextLength;
  // [zkdev] Cap reserved tokens at AUTOCOMPLETE_MAX_TOKENS (256) since autocomplete
  // generation is capped there. Use Math.min to ensure 256 overrides even when
  // llm.completionOptions.maxTokens is pre-set to a larger default (e.g. 4096).
  const reservedTokens = Math.min(
    llm.completionOptions.maxTokens ?? AUTOCOMPLETE_MAX_TOKENS,
    AUTOCOMPLETE_MAX_TOKENS,
  );
  const safetyBuffer = getTokenCountingBufferSafety(contextLength);
  const maxAllowedPromptTokens = contextLength - reservedTokens - safetyBuffer;
  // [zkdev] Use fast char-based estimation to avoid expensive tokenizer call.
  // Exact token counting is not needed here — we only need to detect overflow.
  const promptTokenCount = estimateTokensFast(prompt);
  return promptTokenCount - maxAllowedPromptTokens;
}

export function renderPromptWithTokenLimit({
  snippetPayload,
  workspaceDirs,
  helper,
  llm,
}: {
  snippetPayload: SnippetPayload;
  workspaceDirs: string[];
  helper: HelperVars;
  llm: ILLM | undefined;
}): {
  prompt: string;
  prefix: string;
  suffix: string;
  completionOptions: Partial<CompletionOptions> | undefined;
} {
  const {
    prefix: initialPrefix,
    suffix: initialSuffix,
    reponame,
    template,
    compilePrefixSuffix,
    completionOptions,
    snippets,
  } = preparePromptContext({ snippetPayload, workspaceDirs, helper });

  // We'll mutate prefix/suffix during pruning, so copy them.
  let prefix = initialPrefix;
  let suffix = initialSuffix;

  let {
    prompt,
    prefix: compiledPrefix,
    suffix: compiledSuffix,
  } = buildPrompt(
    template,
    compilePrefixSuffix,
    prefix,
    suffix,
    helper,
    snippets,
    workspaceDirs,
    reponame,
  );

  // Truncate prefix and suffix if prompt tokens exceed maxAllowedPromptTokens
  if (llm) {
    const prune = pruneLength(llm, prompt);
    if (prune > 0) {
      // [zkdev] Use fast char-based estimation for the overflow pruning path.
      // The original code called countTokens() (llamaTokenizer) per-line,
      // adding 200-400ms. Fast estimation is sufficient here — the initial
      // prunePrefixSuffix already did a coarse cut, this is just a safety net.
      const tokensToDrop = prune;
      const prefixTokenCount = estimateTokensFast(prefix);
      const suffixTokenCount = estimateTokensFast(suffix);
      const totalContextTokens = prefixTokenCount + suffixTokenCount;
      if (totalContextTokens > 0) {
        const dropPrefix = Math.ceil(
          tokensToDrop * (prefixTokenCount / totalContextTokens),
        );
        const dropSuffix = Math.ceil(tokensToDrop - dropPrefix);
        const allowedPrefixTokens = Math.max(0, prefixTokenCount - dropPrefix);
        const allowedSuffixTokens = Math.max(0, suffixTokenCount - dropSuffix);
        prefix = pruneLinesFromTopFast(prefix, allowedPrefixTokens);
        suffix = pruneLinesFromBottomFast(suffix, allowedSuffixTokens);
      }
      ({
        prompt,
        prefix: compiledPrefix,
        suffix: compiledSuffix,
      } = buildPrompt(
        template,
        compilePrefixSuffix,
        prefix,
        suffix,
        helper,
        snippets,
        workspaceDirs,
        reponame,
      ));
    }
  }

  const stopTokens = getStopTokens(
    completionOptions,
    helper.lang,
    helper.modelName,
  );

  const estimatedPromptTokens = estimateTokensFast(prompt);
  const estimatedPrefixTokens = estimateTokensFast(compiledPrefix);
  const estimatedSuffixTokens = estimateTokensFast(compiledSuffix);
  const remainingPromptBudget = Math.max(
    0,
    helper.options.maxPromptTokens - estimatedPromptTokens,
  );

  console.log(
    `[Autocomplete Prompt Tokens] model=${helper.modelName} file=${helper.filepath} ` +
      `maxPromptTokens=${helper.options.maxPromptTokens} ` +
      `prefixPct=${helper.options.prefixPercentage} ` +
      `suffixPct=${helper.options.maxSuffixPercentage} ` +
      `estPrefixTokens=${estimatedPrefixTokens} ` +
      `estSuffixTokens=${estimatedSuffixTokens} ` +
      `estPromptTokens=${estimatedPromptTokens} ` +
      `remainingPromptBudget=${remainingPromptBudget}`,
  );

  // [zkdev] Log prompt composition separately so token usage and body are easier to scan.
  console.log(
    `[Autocomplete Prompt Structure] model=${helper.modelName} file=${helper.filepath} ` +
      `snippetCount=${snippets.length} ` +
      `prefixLen=${compiledPrefix.length} ` +
      `suffixLen=${compiledSuffix.length} ` +
      `promptLen=${prompt.length}\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`,
  );

  return {
    prompt,
    prefix: compiledPrefix,
    suffix: compiledSuffix,
    completionOptions: {
      maxTokens: AUTOCOMPLETE_MAX_TOKENS,
      ...completionOptions,
      stop: stopTokens,
    },
  };
}
