import { RequestOptions } from "@continuedev/config-types";
import { fetchwithRequestOptions, patchedFetch } from "@continuedev/fetch";
import {
  ChatCompletionChunk,
  CompletionUsage,
  CreateEmbeddingResponse,
  Model,
} from "openai/resources/index";

import { ChatCompletion } from "openai/resources/index.js";
import { CreateRerankResponse } from "./apis/base.js";

export function chatChunk(options: {
  content: string | null | undefined;
  model: string;
  finish_reason?: ChatCompletionChunk.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [
      {
        delta: {
          content: options.content,
          role: "assistant",
        },
        finish_reason: options.finish_reason ?? "stop",
        index: 0,
        logprobs: null,
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function usageChatChunk(options: {
  model: string;
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function chatChunkFromDelta(options: {
  delta: ChatCompletionChunk.Choice["delta"];
  model: string;
  finish_reason?: ChatCompletionChunk.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [
      {
        delta: options.delta,
        finish_reason: options.finish_reason ?? "stop",
        index: 0,
        logprobs: null,
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function chatCompletion(options: {
  content: string | null | undefined;
  model: string;
  finish_reason?: ChatCompletion.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
  index?: number | null;
}): ChatCompletion {
  return {
    choices: [
      {
        finish_reason: options.finish_reason ?? "stop",
        index: options.index ?? 0,
        logprobs: null,
        message: {
          content: options.content ?? null,
          role: "assistant",
          refusal: null,
        },
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion",
  };
}

export function embedding(options: {
  data: number[][];
  model: string;
  usage?: CreateEmbeddingResponse.Usage;
}): CreateEmbeddingResponse {
  return {
    data: options.data.map((embedding, i) => ({
      index: i,
      embedding: embedding,
      object: "embedding" as const,
    })),
    model: options.model,
    object: "list" as const,
    usage: options.usage ?? {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function rerank(options: {
  model: string;
  data: number[];
  usage?: CreateRerankResponse["usage"];
}): CreateRerankResponse {
  return {
    data: options.data.map((score, index) => ({
      index,
      relevance_score: score,
    })),
    model: options.model,
    object: "list" as const,
    usage: options.usage ?? {
      total_tokens: 0,
    },
  };
}

export function model(options: { id: string; owned_by?: string }): Model {
  return {
    id: options.id,
    object: "model",
    created: Date.now(),
    owned_by: options.owned_by ?? "organization-owner",
  };
}

export function customFetch(
  requestOptions: RequestOptions | undefined,
): typeof patchedFetch {
  if (process.env.FEATURE_FLAG_DISABLE_CUSTOM_FETCH) {
    return patchedFetch;
  }

  function letRequestOptionsOverrideAuthHeaders(init: any): any {
    if (!init || !init.headers || !requestOptions || !requestOptions.headers) {
      return init;
    }

    // Check if custom Authorization or x-api-key headers are provided
    const hasCustomAuth =
      requestOptions.headers["Authorization"] ||
      requestOptions.headers["authorization"];
    const hasCustomXApiKey =
      requestOptions.headers["x-api-key"] ||
      requestOptions.headers["X-Api-Key"];

    // Remove default auth headers if custom ones are provided
    if (hasCustomAuth || hasCustomXApiKey) {
      if (init.headers instanceof Headers) {
        if (hasCustomAuth) {
          init.headers.delete("Authorization");
        }
        if (hasCustomXApiKey) {
          init.headers.delete("x-api-key");
        }
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter((header: [string, string]) => {
          const headerLower = (header[0] ?? "").toLowerCase();
          if (hasCustomAuth && headerLower === "authorization") return false;
          if (hasCustomXApiKey && headerLower === "x-api-key") return false;
          return true;
        });
      } else if (typeof init.headers === "object") {
        if (hasCustomAuth) {
          delete init.headers["Authorization"];
          delete init.headers["authorization"];
        }
        if (hasCustomXApiKey) {
          delete init.headers["x-api-key"];
          delete init.headers["X-Api-Key"];
        }
      }
    }
    return init;
  }

  async function doFetch(req: URL | string | Request, init?: any) {
    init = letRequestOptionsOverrideAuthHeaders(init);
    const url = typeof req === "string" || req instanceof URL ? req : req.url;
    const response = await fetchwithRequestOptions(url, init, requestOptions);

    // On non-2xx, clone and read the body for diagnostics. The upstream SDK
    // (e.g. openai-node) sometimes reports "(no body)" for streaming 4xx
    // because the body stream is consumed/aborted before the error is raised.
    // Cloning preserves the original Response for the SDK.
    if (!response.ok) {
      try {
        const bodyText = await response.clone().text();
        if (bodyText) {
          const preview =
            bodyText.length > 2000
              ? `${bodyText.slice(0, 2000)}...<truncated ${bodyText.length - 2000} chars>`
              : bodyText;
          console.error(
            `[customFetch] HTTP ${response.status} ${response.statusText} ${String(
              url,
            )} body:`,
            preview,
          );
        }
      } catch {
        // ignore body-read errors; preserve original response
      }
    }
    return response;
  }

  return doFetch as typeof patchedFetch;
}
