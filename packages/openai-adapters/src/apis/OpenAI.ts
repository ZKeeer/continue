import { streamSse } from "@continuedev/fetch";
import { OpenAI } from "openai/index";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  Model,
} from "openai/resources/index";
import type {
  Response,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { z } from "zod";
import { isLlmDebugLoggingEnabled, logLlmDebug } from "../debugLogging.js";
import { OpenAIConfigSchema } from "../types.js";
import { customFetch } from "../util.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import {
  createResponsesStreamState,
  fromResponsesChunk,
  isResponsesModel,
  responseToChatCompletion,
  toResponsesParams,
} from "./openaiResponses.js";

function truncateForDebug(value: string, maxLength = 160): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`
    : value;
}

function summarizeMessageContentForDebug(
  content: unknown,
): Record<string, unknown> {
  if (typeof content === "string") {
    return {
      contentType: "string",
      textLength: content.length,
      preview: truncateForDebug(content),
    };
  }

  if (Array.isArray(content)) {
    return {
      contentType: "array",
      partCount: content.length,
      partTypes: content.map((part: any) => part?.type ?? typeof part),
      textLength: content.reduce((total, part: any) => {
        if (part?.type === "text" && typeof part.text === "string") {
          return total + part.text.length;
        }
        return total;
      }, 0),
    };
  }

  return {
    contentType: content == null ? String(content) : typeof content,
  };
}

type DebugMessageSummary = {
  index: number;
  role: unknown;
  contentType?: unknown;
  textLength?: number;
  preview?: string;
  partCount?: number;
  partTypes?: unknown[];
  hasToolCalls: boolean;
  toolCallCount: number;
  hasReasoning: boolean;
  hasReasoningContent: boolean;
  reasoningContentLength?: number;
  reasoningDetailsCount: number;
};

function summarizeChatBodyForDebug(
  body: ChatCompletionCreateParams,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const messageSummaries: DebugMessageSummary[] = messages.map(
    (message: any, index) => {
      const contentSummary = summarizeMessageContentForDebug(
        message?.content,
      ) as DebugMessageSummary;
      return {
        ...contentSummary,
        index,
        role: message?.role,
        hasToolCalls:
          Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
        toolCallCount: Array.isArray(message?.tool_calls)
          ? message.tool_calls.length
          : 0,
        hasReasoning: Object.prototype.hasOwnProperty.call(
          message ?? {},
          "reasoning",
        ),
        hasReasoningContent: Object.prototype.hasOwnProperty.call(
          message ?? {},
          "reasoning_content",
        ),
        reasoningContentLength:
          typeof message?.reasoning_content === "string"
            ? message.reasoning_content.length
            : undefined,
        reasoningDetailsCount: Array.isArray(message?.reasoning_details)
          ? message.reasoning_details.length
          : 0,
      };
    },
  );

  const suspiciousFields = new Set<string>();
  if (Object.prototype.hasOwnProperty.call(body, "stream_options")) {
    suspiciousFields.add("stream_options");
  }
  if (Object.prototype.hasOwnProperty.call(body, "prediction")) {
    suspiciousFields.add("prediction");
  }
  if (Object.prototype.hasOwnProperty.call(body, "tool_choice")) {
    suspiciousFields.add("tool_choice");
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    suspiciousFields.add("tools");
  }
  if (Object.prototype.hasOwnProperty.call(body, "parallel_tool_calls")) {
    suspiciousFields.add("parallel_tool_calls");
  }
  if (messageSummaries.some((message) => message.hasReasoning)) {
    suspiciousFields.add("message.reasoning");
  }
  if (messageSummaries.some((message) => message.hasReasoningContent)) {
    suspiciousFields.add("message.reasoning_content");
  }
  if (
    messageSummaries.some(
      (message) =>
        typeof message.reasoningDetailsCount === "number" &&
        message.reasoningDetailsCount > 0,
    )
  ) {
    suspiciousFields.add("message.reasoning_details");
  }

  return {
    model: body.model,
    stream: body.stream,
    maxTokens: (body as any).max_tokens,
    maxCompletionTokens: (body as any).max_completion_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopCount: Array.isArray(body.stop) ? body.stop.length : body.stop ? 1 : 0,
    toolChoice: body.tool_choice,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    parallelToolCalls: (body as any).parallel_tool_calls,
    hasPrediction: Object.prototype.hasOwnProperty.call(body, "prediction"),
    hasStreamOptions: Object.prototype.hasOwnProperty.call(
      body,
      "stream_options",
    ),
    messageCount: messageSummaries.length,
    totalMessageTextLength: messageSummaries.reduce(
      (total, message) =>
        total +
        (typeof message.textLength === "number" ? message.textLength : 0),
      0,
    ),
    messageSummaries,
    suspiciousFields: [...suspiciousFields],
  };
}

function summarizeOpenAIErrorForDebug(error: unknown): Record<string, unknown> {
  const err = error as any;
  const responseHeaders =
    err?.headers && typeof err.headers.entries === "function"
      ? Object.fromEntries(
          Array.from(err.headers.entries()) as [string, string][],
        )
      : undefined;

  return {
    name: err?.name,
    message: err?.message,
    status: err?.status ?? err?.response?.status,
    code: err?.code,
    type: err?.type,
    param: err?.param,
    requestId: err?.request_id ?? err?.requestId,
    responseHeaders,
    causeMessage: err?.cause?.message,
    errorPayload: err?.error,
  };
}

function cloneChatBodyForDebug<T extends ChatCompletionCreateParams>(
  body: T,
): T {
  return JSON.parse(JSON.stringify(body));
}

/**
 * Audit every assistant message's tool_calls[].function.arguments.
 * Per the OpenAI spec this field is a STRING that the server will
 * json.loads() again. A malformed/truncated string here is the classic
 * trigger of `unexpected end of data` 400 errors from strict servers
 * like sglang / vLLM. We log per-call: length, JSON-parse validity,
 * head/tail preview so a truncation (e.g. arguments ending mid-string)
 * is visible at a glance.
 */
function auditToolCallArguments(
  label: string,
  body: ChatCompletionCreateParams,
): void {
  if (!isLlmDebugLoggingEnabled()) {
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const findings: Array<Record<string, unknown>> = [];
  messages.forEach((message: any, msgIndex) => {
    if (!Array.isArray(message?.tool_calls)) return;
    message.tool_calls.forEach((tc: any, tcIndex: number) => {
      const args = tc?.function?.arguments;
      const argsType = typeof args;
      const isString = argsType === "string";
      const length = isString ? args.length : -1;
      let parseOk = false;
      let parseError: string | undefined;
      if (isString) {
        try {
          JSON.parse(args);
          parseOk = true;
        } catch (e: any) {
          parseError = e?.message;
        }
      }
      const head = isString ? args.slice(0, 80) : undefined;
      const tail = isString && length > 80 ? args.slice(-80) : undefined;
      findings.push({
        msgIndex,
        role: message?.role,
        tcIndex,
        id: tc?.id,
        name: tc?.function?.name,
        argsType,
        length,
        parseOk,
        parseError,
        head,
        tail,
      });
    });
  });
  const invalid = findings.filter((f) => f.argsType === "string" && !f.parseOk);
  console.log(
    `[OpenAIApi][toolCallAudit] ${label} totalToolCalls=${findings.length} invalidJsonArgs=${invalid.length}`,
    JSON.stringify(findings, null, 2),
  );
}

/**
 * Compute serialized body size so the reader can cross-check against
 * what is actually written to the socket in fetchwithRequestOptions.
 * If the two numbers disagree we have a string-level truncation in
 * between (that is exactly the "4096-style" concern).
 */
function measureSerializedBodyForDebug(body: ChatCompletionCreateParams): {
  bodyLength: number;
  tail: string;
} {
  let serialized = "";
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { bodyLength: -1, tail: "" };
  }
  return {
    bodyLength: serialized.length,
    tail:
      serialized.length > 120
        ? serialized.slice(serialized.length - 120)
        : serialized,
  };
}

export class OpenAIApi implements BaseLlmApi {
  openai: OpenAI;
  apiBase: string = "https://api.openai.com/v1/";

  constructor(protected config: z.infer<typeof OpenAIConfigSchema>) {
    this.apiBase = config.apiBase ?? this.apiBase;

    // Always create the original OpenAI client for fallback
    this.openai = new OpenAI({
      // Necessary because `new OpenAI()` will throw an error if there is no API Key
      apiKey: config.apiKey ?? "",
      baseURL: this.apiBase,
      fetch: customFetch(config.requestOptions),
      timeout: config?.requestOptions?.timeout || undefined,
    });
  }
  modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    // Add stream_options to include usage in streaming responses
    if (body.stream) {
      (body as any).stream_options = { include_usage: true };
    }

    // DeepSeek reasoner models use max_completion_tokens instead of max_tokens
    if (
      body.max_tokens &&
      (this.apiBase?.includes("api.deepseek.com") ||
        body.model.includes("deepseek-reasoner"))
    ) {
      body.max_completion_tokens = body.max_tokens;
      body.max_tokens = undefined;
    }

    // o-series models - only apply for official OpenAI API
    const isOfficialOpenAIAPI = this.apiBase === "https://api.openai.com/v1/";
    if (isOfficialOpenAIAPI) {
      if (body.model.startsWith("o") || body.model.includes("gpt-5")) {
        // a) use max_completion_tokens instead of max_tokens
        body.max_completion_tokens = body.max_tokens;
        body.max_tokens = undefined;

        // b) use "developer" message role rather than "system"
        body.messages = body.messages.map((message) => {
          if (message.role === "system") {
            return { ...message, role: "developer" } as any;
          }
          return message;
        });
      }
      if (body.tools?.length && !body.model.startsWith("o3")) {
        body.parallel_tool_calls = false;
      }
    }
    return body;
  }

  protected shouldUseResponsesEndpoint(model: string): boolean {
    if (this.config.useResponsesApi === false) {
      return false;
    }
    const isOfficialOpenAIAPI = this.apiBase === "https://api.openai.com/v1/";
    return isOfficialOpenAIAPI && isResponsesModel(model);
  }

  modifyCompletionBody<
    T extends
      | CompletionCreateParamsNonStreaming
      | CompletionCreateParamsStreaming,
  >(body: T): T {
    return body;
  }

  modifyEmbedBody<T extends OpenAI.Embeddings.EmbeddingCreateParams>(
    body: T,
  ): T {
    return body;
  }

  modifyFimBody<T extends FimCreateParamsStreaming>(body: T): T {
    return body;
  }

  modifyRerankBody<T extends RerankCreateParams>(body: T): T {
    return body;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": this.config.apiKey ?? "",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private logChatCompletionFailure(
    operation: "chatCompletionNonStream" | "chatCompletionStream",
    error: unknown,
    originalBody: ChatCompletionCreateParams,
    finalBody: ChatCompletionCreateParams,
  ) {
    console.error(
      `[OpenAIApi] ${operation} failed`,
      JSON.stringify(
        {
          apiBase: this.apiBase,
          operation,
          error: summarizeOpenAIErrorForDebug(error),
          originalRequest: summarizeChatBodyForDebug(originalBody),
          finalRequest: summarizeChatBodyForDebug(finalBody),
        },
        null,
        2,
      ),
    );
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    if (this.shouldUseResponsesEndpoint(body.model)) {
      const response = await this.responsesNonStream(body, signal);
      return responseToChatCompletion(response);
    }
    const originalBody = cloneChatBodyForDebug(body);
    const finalBody = this.modifyChatBody(body);
    logLlmDebug("OpenAI chatCompletionNonStream request params", {
      apiBase: this.apiBase,
      requestOptions: this.config.requestOptions,
      originalBody,
      finalBody,
    });
    auditToolCallArguments("preSend.nonStream", finalBody);
    {
      const m = measureSerializedBodyForDebug(finalBody);
      console.log(
        `[OpenAIApi][preSend] nonStream serializedBodyLength=${m.bodyLength} tail=${JSON.stringify(m.tail)}`,
      );
    }
    try {
      const response = await this.openai.chat.completions.create(finalBody, {
        signal,
      });
      return response;
    } catch (error) {
      logLlmDebug("OpenAI chatCompletionNonStream error params", {
        apiBase: this.apiBase,
        request: finalBody,
        error,
      });
      auditToolCallArguments("onError.nonStream", finalBody);
      this.logChatCompletionFailure(
        "chatCompletionNonStream",
        error,
        originalBody,
        finalBody,
      );
      throw error;
    }
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    if (this.shouldUseResponsesEndpoint(body.model)) {
      for await (const chunk of this.responsesStream(body, signal)) {
        yield chunk;
      }
      return;
    }
    const originalBody = cloneChatBodyForDebug(body);
    const finalBody = this.modifyChatBody(body);
    logLlmDebug("OpenAI chatCompletionStream request params", {
      apiBase: this.apiBase,
      requestOptions: this.config.requestOptions,
      originalBody,
      finalBody,
    });
    auditToolCallArguments("preSend.stream", finalBody);
    {
      const m = measureSerializedBodyForDebug(finalBody);
      console.log(
        `[OpenAIApi][preSend] stream serializedBodyLength=${m.bodyLength} tail=${JSON.stringify(m.tail)}`,
      );
    }
    try {
      const response = await this.openai.chat.completions.create(finalBody, {
        signal,
      });
      let lastChunkWithUsage: ChatCompletionChunk | undefined;
      for await (const result of response) {
        // Check if this chunk contains usage information
        if (result.usage) {
          // Store it to emit after all content chunks
          lastChunkWithUsage = result;
        } else {
          yield result;
        }
      }
      // Emit the usage chunk at the end if we have one
      if (lastChunkWithUsage) {
        yield lastChunkWithUsage;
      }
    } catch (error) {
      logLlmDebug("OpenAI chatCompletionStream error params", {
        apiBase: this.apiBase,
        request: finalBody,
        error,
      });
      auditToolCallArguments("onError.stream", finalBody);
      this.logChatCompletionFailure(
        "chatCompletionStream",
        error,
        originalBody,
        finalBody,
      );
      throw error;
    }
  }
  async completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    const response = await this.openai.completions.create(
      this.modifyCompletionBody(body),
      { signal },
    );
    return response;
  }
  async *completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion, any, unknown> {
    const response = await this.openai.completions.create(
      this.modifyCompletionBody(body),
      { signal },
    );
    for await (const result of response) {
      yield result;
    }
  }
  async *fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    const endpoint = new URL("fim/completions", this.apiBase);
    const modifiedBody = this.modifyFimBody(body);
    const resp = await customFetch(this.config.requestOptions)(endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: modifiedBody.model,
        prompt: modifiedBody.prompt,
        suffix: modifiedBody.suffix,
        max_tokens: modifiedBody.max_tokens,
        max_completion_tokens: (modifiedBody as any).max_completion_tokens,
        temperature: modifiedBody.temperature,
        top_p: modifiedBody.top_p,
        frequency_penalty: modifiedBody.frequency_penalty,
        presence_penalty: modifiedBody.presence_penalty,
        stop: modifiedBody.stop,
        stream: true,
      }),
      headers: this.getHeaders(),
      signal,
    });
    for await (const chunk of streamSse(resp as any)) {
      if (chunk.choices && chunk.choices.length > 0) {
        yield chunk;
      }
    }
  }

  async embed(
    body: OpenAI.Embeddings.EmbeddingCreateParams,
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    const response = await this.openai.embeddings.create(
      this.modifyEmbedBody(body),
    );
    return response;
  }

  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    const endpoint = new URL("rerank", this.apiBase);
    const modifiedBody = this.modifyRerankBody(body);
    const response = await customFetch(this.config.requestOptions)(endpoint, {
      method: "POST",
      body: JSON.stringify(modifiedBody),
      headers: this.getHeaders(),
    });
    const data = await response.json();
    return data as any;
  }

  async list(): Promise<Model[]> {
    return (await this.openai.models.list()).data;
  }

  async responsesNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Response> {
    const params = toResponsesParams({
      ...(body as ChatCompletionCreateParams),
      stream: false,
    });
    logLlmDebug("OpenAI responsesNonStream request params", {
      apiBase: this.apiBase,
      requestOptions: this.config.requestOptions,
      chatCompletionBody: body,
      responsesParams: params,
    });
    const response = (await this.openai.responses.create(params, {
      signal,
    })) as Response;
    return response;
  }

  async *responsesStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const params = toResponsesParams({
      ...(body as ChatCompletionCreateParams),
      stream: true,
    });

    logLlmDebug("OpenAI responsesStream request params", {
      apiBase: this.apiBase,
      requestOptions: this.config.requestOptions,
      chatCompletionBody: body,
      responsesParams: params,
    });

    const state = createResponsesStreamState({
      model: body.model,
    });

    const stream = this.openai.responses.stream(params as any, {
      signal,
    });

    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
      const chunk = fromResponsesChunk(state, event);
      if (chunk) {
        yield chunk;
      }
    }
  }
}
