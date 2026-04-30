import { ToolCallDelta } from "..";

/**
 * Error thrown when tool call arguments fail to parse.
 * Contains the raw arguments string for error reporting to the model.
 */
export class ToolCallParseError extends Error {
  constructor(
    public readonly toolName: string | undefined,
    public readonly rawArgs: string | undefined,
  ) {
    const argSnippet = rawArgs
      ? rawArgs.substring(0, 200) + (rawArgs.length > 200 ? "..." : "")
      : "(empty)";

    // When the payload is very large (e.g. entire file contents embedded in JSON),
    // LLMs frequently produce malformed JSON. Steer the model toward a safer path.
    const largePayloadHint =
      (rawArgs?.length ?? 0) > 10_000
        ? " Tip: your arguments are very large. For writing large file content, " +
          "use run_terminal_command (e.g. writing to a temp file via heredoc or tee) " +
          "instead of embedding the whole content in a tool call."
        : "";

    super(
      `Failed to parse arguments for tool "${toolName || "unknown"}". ` +
        `Raw arguments: ${argSnippet}. ` +
        `Please provide valid JSON arguments.${largePayloadHint}`,
    );
    this.name = "ToolCallParseError";
  }
}

/**
 * Parse tool call arguments. Used in LLM provider message construction
 * where failure should not abort the request. Returns {} on parse failure.
 */
export function safeParseToolCallArgs(
  toolCall: ToolCallDelta,
): Record<string, any> {
  const args = toolCall.function?.arguments;

  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length > 0
  ) {
    return args;
  }

  try {
    return JSON.parse(toolCall.function?.arguments?.trim() || "{}");
  } catch (e) {
    console.error(
      `Failed to parse tool call arguments:\nTool call: ${toolCall.function?.name + " " + toolCall.id}\nArgs:${toolCall.function?.arguments}\n`,
    );
    return {};
  }
}

/**
 * Parse tool call arguments for tool execution. Throws ToolCallParseError
 * on failure so the error message (with raw args) is sent back to the model,
 * allowing it to self-correct and retry.
 */
export function strictParseToolCallArgs(
  toolCall: ToolCallDelta,
): Record<string, any> {
  const args = toolCall.function?.arguments;

  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length > 0
  ) {
    return args;
  }

  try {
    return JSON.parse(toolCall.function?.arguments?.trim() || "{}");
  } catch (e) {
    throw new ToolCallParseError(
      toolCall.function?.name,
      typeof toolCall.function?.arguments === "string"
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function?.arguments),
    );
  }
}

/**
 * Coerce parsed args to match the tool's input schema types.
 * JSON.parse() deeply parses all values, so string-typed parameters
 * that contain valid JSON (e.g. file content for a .json file) get
 * converted to objects. This checks the schema and re-stringifies
 * any values that should be strings.
 */
export function coerceArgsToSchema(
  args: Record<string, any>,
  schema?: Record<string, any>,
): Record<string, any> {
  if (!schema?.properties) {
    return args;
  }

  const coerced = { ...args };
  for (const [key, value] of Object.entries(coerced)) {
    const propSchema = schema.properties[key];
    if (!propSchema) {
      continue;
    }

    if (
      propSchema.type === "string" &&
      typeof value === "object" &&
      value !== null
    ) {
      try {
        coerced[key] = JSON.stringify(value);
      } catch {
        // leave as-is if stringify fails
      }
    }
  }

  return coerced;
}

export function getStringArg(
  args: any,
  argName: string,
  allowEmpty = false,
): string {
  if (!args || !(argName in args)) {
    throw new Error(
      `\`${argName}\` argument is required${allowEmpty ? "" : " and must not be empty or whitespace-only"}. (type string)`,
    );
  }

  let value = args[argName];

  // Handle case where JSON was parsed into an object by the tool call parser.
  // If the arguments to the tool call are valid JSON (e.g. the model attempts to create a .json file)
  // the earlier call to JSON.parse() will have deeply parsed the returned arguments.
  // If that has happened, convert back to string.
  if (typeof value === "object" && value !== null) {
    try {
      value = JSON.stringify(value);
      return value;
    } catch (e) {
      //Swallow this, because it might be fine later.
    }
  }

  if (typeof value !== "string") {
    throw new Error(
      `\`${argName}\` argument is required${allowEmpty ? "" : " and must not be empty or whitespace-only"}. (type string)`,
    );
  }

  if (!allowEmpty && !value.trim()) {
    throw new Error(`Argument ${argName} must not be empty or whitespace-only`);
  }

  return value;
}

export function getOptionalStringArg(
  args: any,
  argName: string,
  allowEmpty = false,
) {
  if (typeof args?.[argName] === "undefined") {
    return undefined;
  }
  return getStringArg(args, argName, allowEmpty);
}

export function getNumberArg(args: any, argName: string): number {
  if (!args || !(argName in args)) {
    throw new Error(`Argument \`${argName}\` is required (type number)`);
  }
  const value = args[argName];
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`Argument \`${argName}\` must be a valid number`);
    }
    return parsed;
  }
  if (typeof value !== "number" || isNaN(value)) {
    throw new Error(`Argument \`${argName}\` must be a valid number`);
  }
  return Math.floor(value); // Ensure integer for line numbers (supports negative numbers)
}

export function getBooleanArg(args: any, argName: string, required = false) {
  if (!args || !(argName in args)) {
    if (required) {
      throw new Error(`Argument \`${argName}\` is required (type boolean)`);
    } else {
      return undefined;
    }
  }
  if (typeof args[argName] === "string") {
    if (args[argName].toLowerCase() === "false") {
      return false;
    }
    if (args[argName].toLowerCase() === "true") {
      return true;
    }
  }
  if (typeof args[argName] !== "boolean") {
    throw new Error(`Argument \`${argName}\` must be a boolean true or false`);
  }
  return args[argName];
}
