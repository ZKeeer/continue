import { longestCommonSubsequence } from "../../util/lcs.js";
import { lineIsRepeated } from "../filtering/streamTransforms/lineStream.js";

import type { ILLM } from "../../index.js";

function rewritesLineAbove(completion: string, prefix: string): boolean {
  const lineAbove = prefix
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-1)[0];
  if (!lineAbove) {
    return false;
  }

  const firstLineOfCompletion = completion
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstLineOfCompletion) {
    return false;
  }
  return lineIsRepeated(lineAbove, firstLineOfCompletion);
}

const MAX_REPETITION_FREQ_TO_CHECK = 3;
function isExtremeRepetition(completion: string): boolean {
  const lines = completion.split("\n");
  if (lines.length < 6) {
    return false;
  }
  for (let freq = 1; freq < MAX_REPETITION_FREQ_TO_CHECK; freq++) {
    const lcs = longestCommonSubsequence(lines[0], lines[freq]);
    if (lcs.length > 5 || lcs.length > lines[0].length * 0.5) {
      let matchCount = 0;
      for (let i = 0; i < lines.length; i += freq) {
        if (lines[i].includes(lcs)) {
          matchCount++;
        }
      }
      if (matchCount * freq > 8 || (matchCount * freq) / lines.length > 0.8) {
        return true;
      }
    }
  }
  return false;
}
function isOnlyWhitespace(completion: string): boolean {
  const whitespaceRegex = /^[\s]+$/;
  return whitespaceRegex.test(completion);
}

function isBlank(completion: string): boolean {
  return completion.trim().length === 0;
}

/**
 * Removes markdown code block delimiters from completion.
 * Removes the first line if it starts with backticks (with optional language name).
 * Removes the last line if it contains only backticks.
 */
function removeBackticks(completion: string): string {
  const lines = completion.split("\n");

  if (lines.length === 0) {
    return completion;
  }

  let startIdx = 0;
  let endIdx = lines.length;

  // Remove first line if it starts with backticks (``` or ```language)
  const firstLineTrimmed = lines[0].trim();
  if (firstLineTrimmed.startsWith("```")) {
    startIdx = 1;
  }

  // Remove last line if it contains only backticks (one or more)
  if (lines.length > startIdx) {
    const lastLineTrimmed = lines[lines.length - 1].trim();
    if (lastLineTrimmed.length > 0 && /^`+$/.test(lastLineTrimmed)) {
      endIdx = lines.length - 1;
    }
  }

  // If we removed lines, return the modified completion
  if (startIdx > 0 || endIdx < lines.length) {
    return lines.slice(startIdx, endIdx).join("\n");
  }

  return completion;
}

export function postprocessCompletion({
  completion,
  llm,
  prefix,
  suffix,
}: {
  completion: string;
  llm: ILLM;
  prefix: string;
  suffix: string;
}): string | undefined {
  // [zkdev] Strip IntelliJ dummy identifier that may leak through from document text
  completion = completion.replace(/IntellijIdeaRulezzz\s*/g, "");

  // Don't return empty
  if (isBlank(completion)) {
    console.log(
      `[Autocomplete PostReject] reason=isBlank len=${completion.length}`,
    );
    return undefined;
  }

  // Don't return whitespace
  if (isOnlyWhitespace(completion)) {
    console.log(
      `[Autocomplete PostReject] reason=isOnlyWhitespace len=${completion.length}`,
    );
    return undefined;
  }

  // Dont return if it's just a repeat of the line above
  if (rewritesLineAbove(completion, prefix)) {
    console.log(`[Autocomplete PostReject] reason=rewritesLineAbove`);
    return undefined;
  }

  // Filter out repetitions of many lines in a row
  if (isExtremeRepetition(completion)) {
    console.log(`[Autocomplete PostReject] reason=isExtremeRepetition`);
    return undefined;
  }

  if (llm.model.includes("codestral")) {
    // Codestral sometimes starts with an extra space
    if (completion[0] === " " && completion[1] !== " ") {
      if (prefix.endsWith(" ") && suffix.startsWith("\n")) {
        completion = completion.slice(1);
      }
    }

    // When there is no suffix, Codestral tends to begin with a new line
    // We do this to avoid double new lines
    if (
      suffix.length === 0 &&
      prefix.endsWith("\n\n") &&
      completion.startsWith("\n")
    ) {
      // Remove a single leading \n from the completion
      completion = completion.slice(1);
    }
  }

  if (llm.model.includes("qwen3")) {
    // Qwen3 always starts from special thinking markers, and we don't want them to output these contents
    // Remove all content from "
    completion = completion.replace(/<think>.*?<\/think>/s, "");
    completion = completion.replace(/<\/think>/, "");

    // Remove any number of newline characters at the beginning and end
    completion = completion.replace(/^\n+|\n+$/g, "");
  }

  if (llm.model.includes("granite")) {
    // Granite tends to repeat the start of the line in the completion output
    let prefixEnd = prefix.split("\n").pop();
    if (prefixEnd) {
      if (completion.startsWith(prefixEnd)) {
        completion = completion.slice(prefixEnd.length);
      } else {
        const trimmedPrefix = prefixEnd.trim();
        const lastWord = trimmedPrefix.split(/\s+/).pop();
        if (lastWord && completion.startsWith(lastWord)) {
          completion = completion.slice(lastWord.length);
        } else if (completion.startsWith(trimmedPrefix)) {
          completion = completion.slice(trimmedPrefix.length);
        }
      }
    }
  }

  // // If completion starts with multiple whitespaces, but the cursor is at the end of the line
  // // then it should probably be on a new line
  if (
    llm.model.includes("mercury") &&
    (completion.startsWith("  ") || completion.startsWith("\t")) &&
    !prefix.endsWith("\n") &&
    (suffix.startsWith("\n") || suffix.trim().length === 0)
  ) {
    completion = "\n" + completion;
  }

  if (
    (llm.model.includes("gemini") || llm.model.includes("gemma")) &&
    completion.endsWith("<|file_separator|>")
  ) {
    // "<|file_separator|>" is 18 characters long
    completion = completion.slice(0, -18);
  }

  // If prefix ends with space and so does completion, then remove the space from completion

  if (prefix.endsWith(" ") && completion.startsWith(" ")) {
    completion = completion.slice(1);
  }

  // Remove markdown code block delimiters
  completion = removeBackticks(completion);

  // [zkdev] Suffix dedup: trim trailing overlap between completion and suffix
  // e.g. completion="foo();\nbar();" suffix="\nbar();\nbaz();" → trim "\nbar();"
  if (suffix.length > 0 && completion.length > 0) {
    completion = trimSuffixOverlap(completion, suffix);
  }

  return completion;
}

/**
 * [zkdev] Remove the longest suffix of `completion` that is a prefix of `suffix`.
 * This prevents the completion from inserting text already present after the cursor.
 */
function trimSuffixOverlap(completion: string, suffix: string): string {
  // Normalize whitespace for comparison: trim trailing whitespace on each line
  const suffixTrimmed = suffix.replace(/^[\t ]*\n/, "\n");
  const maxCheck = Math.min(completion.length, suffix.length);

  let longestOverlap = 0;
  for (let len = 1; len <= maxCheck; len++) {
    const completionTail = completion.slice(-len);
    const suffixHead = suffixTrimmed.slice(0, len);
    if (completionTail === suffixHead) {
      longestOverlap = len;
    }
  }

  if (longestOverlap > 0) {
    return completion.slice(0, -longestOverlap);
  }

  // Also check line-based overlap: if last lines of completion match first lines of suffix
  const completionLines = completion.split("\n");
  const suffixLines = suffix.split("\n");

  for (
    let overlapLines = Math.min(completionLines.length, suffixLines.length);
    overlapLines >= 1;
    overlapLines--
  ) {
    const tailLines = completionLines.slice(-overlapLines);
    const headLines = suffixLines.slice(0, overlapLines);
    const match = tailLines.every(
      (line, i) => line.trim() === headLines[i].trim(),
    );
    if (match) {
      return completionLines.slice(0, -overlapLines).join("\n");
    }
  }

  return completion;
}
