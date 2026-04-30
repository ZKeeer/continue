import { PromptTemplateFunction } from "../../..";
import { dedent } from "../../../util";

const gptInsertionEditPrompt: PromptTemplateFunction = (_, otherData) => {
  return dedent`
    \`\`\`${otherData.language}
    ${otherData.prefix}[BLANK]${otherData.codeToEdit}${otherData.suffix}
    \`\`\`

    Above is the file of code that the user is currently editing in. Their cursor is located at the "[BLANK]". They have requested that you fill in the "[BLANK]" with code that satisfies the following request:

    "${otherData.userInput}"

    Please generate this code. Your output will be only the code that should replace the "[BLANK]", without repeating any of the prefix or suffix, without any natural language explanation, and without messing up indentation. Here is the code that will replace the "[BLANK]":`;
};

const gptFullFileEditPrompt: PromptTemplateFunction = (_, otherData) => {
  return dedent`
    \`\`\`${otherData.language}
    ${otherData.codeToEdit}
    \`\`\`

    Please rewrite the above file to address the following request:

    ${otherData.userInput}

    You should rewrite the entire file without any natural language explanation. DO NOT surround the code in a code block and DO NOT explain yourself.`;
};

export const gptEditPrompt: PromptTemplateFunction = (history, otherData) => {
  if (otherData?.codeToEdit?.trim().length === 0) {
    return gptInsertionEditPrompt(history, otherData);
  } else if (
    otherData?.prefix?.trim().length === 0 &&
    otherData?.suffix?.trim().length === 0
  ) {
    return gptFullFileEditPrompt(history, otherData);
  }

  const paragraphs = [
    "The user has requested a section of code in a file to be rewritten.",
  ];

  if (otherData.prefix?.trim().length > 0) {
    paragraphs.push(dedent`
        This is the prefix of the file:
        \`\`\`${otherData.language}
        ${otherData.prefix}
        \`\`\``);
  }

  if (otherData.suffix?.trim().length > 0) {
    paragraphs.push(dedent`
        This is the suffix of the file:
        \`\`\`${otherData.language}
        ${otherData.suffix}
        \`\`\``);
  }

  paragraphs.push(dedent`
        This is the code to rewrite:
        \`\`\`${otherData.language}
        ${otherData.codeToEdit}
        \`\`\`

        The user's request is: "${otherData.userInput}"
        
        DO NOT output any natural language, only output the code changes.

        Here is the rewritten code:`);

  return paragraphs.join("\n\n");
};

export const defaultApplyPrompt: PromptTemplateFunction = (
  _history,
  otherData,
) => {
  const hasPrefixSuffix =
    otherData.prefix?.trim().length > 0 ||
    otherData.suffix?.trim().length > 0;

  if (hasPrefixSuffix) {
    const paragraphs = [
      "The user has requested that a suggested edit be applied to a section of code in a file.",
    ];

    if (otherData.prefix?.trim().length > 0) {
      paragraphs.push(dedent`
        This is the prefix of the file:
        \`\`\`${otherData.language}
        ${otherData.prefix}
        \`\`\``);
    }

    if (otherData.suffix?.trim().length > 0) {
      paragraphs.push(dedent`
        This is the suffix of the file:
        \`\`\`${otherData.language}
        ${otherData.suffix}
        \`\`\``);
    }

    paragraphs.push(dedent`
      This is the code to modify:
      \`\`\`${otherData.language}
      ${otherData.codeToEdit}
      \`\`\`

      SUGGESTED EDIT:
      \`\`\`${otherData.language}
      ${otherData.new_code}
      \`\`\`

      Apply the SUGGESTED EDIT to the code. Only output the modified code within the range, not the prefix or suffix. Do NOT output any natural language.

      Here is the rewritten code:`);

    return paragraphs.join("\n\n");
  }

  return [
    {
      role: "user",
      content: dedent`
        ORIGINAL CODE:
        \`\`\`
        ${otherData.original_code}
        \`\`\`

        SUGGESTED EDIT:
        \`\`\`
        ${otherData.new_code}
        \`\`\`

        Apply the SUGGESTED EDIT to the ORIGINAL CODE. Output the complete modified code.
        - Output ONLY code. Do NOT explain, summarize, or describe changes.
        - Leave existing comments in place unless changes require modifying them.
        - Preserve all unchanged code exactly as-is.`,
    },
    {
      role: "assistant",
      content: "```\n",
    },
  ];
};
