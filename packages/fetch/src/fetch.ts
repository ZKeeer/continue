import { RequestOptions } from "@continuedev/config-types";
import * as followRedirects from "follow-redirects";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { BodyInit, RequestInit, Response } from "node-fetch";
import { getAgentOptions } from "./getAgentOptions.js";
import patchedFetch from "./node-fetch-patch.js";
import { getProxy, shouldBypassProxy } from "./util.js";

const { http, https } = (followRedirects as any).default;

const SECRET_KEY_PATTERN =
  /(authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|secret|password|credential|secretAccessKey|accessKeyId)/i;

function shouldRedactKey(key: string): boolean {
  if (/reasoning|thinking/i.test(key)) {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function redactRecord(record: { [key: string]: string }): {
  [key: string]: string;
} {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      shouldRedactKey(key) ? "[REDACTED]" : value,
    ]),
  );
}

function isLlmDebugLoggingEnabled(): boolean {
  const value = process.env.CONTINUE_LLM_DEBUG_LOG?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function parseBodyForSummary(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function getTextLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, nestedValue) => total + getTextLength(nestedValue),
      0,
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.length;
    }
    if (typeof record.content === "string") {
      return record.content.length;
    }
    if (Array.isArray(record.content)) {
      return getTextLength(record.content);
    }
  }
  return 0;
}

function getContentSummary(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    return {
      contentType: "string",
      textLength: content.length,
    };
  }

  if (Array.isArray(content)) {
    return {
      contentType: "array",
      partCount: content.length,
      partTypes: content.map((part: any) => part?.type ?? typeof part),
      textLength: getTextLength(content),
    };
  }

  return {
    contentType: content == null ? String(content) : typeof content,
    textLength: getTextLength(content),
  };
}

function getRequestItemSummaries(
  items: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item: any, index) => ({
    ...getContentSummary(item?.content ?? item),
    index,
    role: item?.role,
    hasToolCalls: Array.isArray(item?.tool_calls) && item.tool_calls.length > 0,
    toolCallCount: Array.isArray(item?.tool_calls) ? item.tool_calls.length : 0,
  }));
}

export function summarizeLlmRequestBodyForDebug(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  const parsedBody = parseBodyForSummary(body) as any;
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    Array.isArray(parsedBody)
  ) {
    return {
      bodyType: parsedBody == null ? String(parsedBody) : typeof parsedBody,
    };
  }

  const messageSummaries = getRequestItemSummaries(parsedBody.messages);
  const inputSummaries = getRequestItemSummaries(parsedBody.input);

  return {
    model: parsedBody.model,
    stream: parsedBody.stream,
    maxTokens: parsedBody.max_tokens,
    maxCompletionTokens: parsedBody.max_completion_tokens,
    maxOutputTokens: parsedBody.max_output_tokens,
    temperature: parsedBody.temperature,
    topP: parsedBody.top_p,
    reasoningEffort:
      parsedBody.reasoning_effort ?? parsedBody.reasoning?.effort,
    verbosity: parsedBody.verbosity ?? parsedBody.text?.verbosity,
    stopCount: Array.isArray(parsedBody.stop)
      ? parsedBody.stop.length
      : parsedBody.stop
        ? 1
        : 0,
    toolChoice: parsedBody.tool_choice,
    toolCount: Array.isArray(parsedBody.tools) ? parsedBody.tools.length : 0,
    parallelToolCalls: parsedBody.parallel_tool_calls,
    hasPrediction: Object.prototype.hasOwnProperty.call(
      parsedBody,
      "prediction",
    ),
    hasStreamOptions: Object.prototype.hasOwnProperty.call(
      parsedBody,
      "stream_options",
    ),
    messageCount: messageSummaries.length,
    inputCount: inputSummaries.length,
    totalMessageTextLength: messageSummaries.reduce(
      (total, message) =>
        total +
        (typeof message.textLength === "number" ? message.textLength : 0),
      0,
    ),
    totalInputTextLength: inputSummaries.reduce(
      (total, input) =>
        total + (typeof input.textLength === "number" ? input.textLength : 0),
      0,
    ),
    messageSummaries,
    inputSummaries,
  };
}

function stringifyLlmDebug(value: unknown): string {
  return JSON.stringify(
    value,
    (key, nestedValue) => {
      if (nestedValue === undefined) {
        return "[undefined]";
      }
      if (shouldRedactKey(key)) {
        return "[REDACTED]";
      }
      return nestedValue;
    },
    2,
  );
}

function isLlmEndpoint(pathname: string): boolean {
  return (
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/completions") ||
    pathname.endsWith("/responses") ||
    pathname.endsWith("/messages") ||
    pathname.endsWith("/api/chat") ||
    pathname.endsWith("/api/generate")
  );
}

function logLlmWireRequest(
  method: string,
  url: URL,
  headers: { [key: string]: string },
  body: BodyInit | null | undefined,
  proxy?: string,
  shouldBypass?: boolean,
) {
  if (!isLlmDebugLoggingEnabled() || !isLlmEndpoint(url.pathname)) {
    return;
  }

  console.log(
    `[LLM_DEBUG] fetchwithRequestOptions final on-wire request params\n${stringifyLlmDebug(
      {
        method,
        url: url.toString(),
        headers: redactRecord(headers),
        proxy: proxy && !shouldBypass ? proxy : undefined,
        body: summarizeLlmRequestBodyForDebug(body),
        rawBodyLength: typeof body === "string" ? body.length : undefined,
      },
    )}`,
  );
}

function logRequest(
  method: string,
  url: URL,
  headers: { [key: string]: string },
  body: BodyInit | null | undefined,
  proxy?: string,
  shouldBypass?: boolean,
) {
  console.log("=== FETCH REQUEST ===");
  console.log(`Method: ${method}`);
  console.log(`URL: ${url.toString()}`);

  // Log headers in curl format
  console.log("Headers:");
  for (const [key, value] of Object.entries(redactRecord(headers))) {
    console.log(`  -H '${key}: ${value}'`);
  }

  // Log proxy information
  if (proxy && !shouldBypass) {
    console.log(`Proxy: ${proxy}`);
  }

  // Log body
  if (body) {
    console.log(`Body: ${body}`);
  }

  // Generate equivalent curl command
  let curlCommand = `curl -X ${method}`;
  for (const [key, value] of Object.entries(redactRecord(headers))) {
    curlCommand += ` -H '${key}: ${value}'`;
  }
  if (body) {
    curlCommand += ` -d '${body}'`;
  }
  if (proxy && !shouldBypass) {
    curlCommand += ` --proxy '${proxy}'`;
  }
  curlCommand += ` '${url.toString()}'`;
  console.log(`Equivalent curl: ${curlCommand}`);
  console.log("=====================");
}

function logError(error: unknown) {
  console.log("=== FETCH ERROR ===");
  console.log(`Error: ${error}`);
  console.log("===================");
}

export async function fetchwithRequestOptions(
  url_: URL | string,
  init?: RequestInit,
  requestOptions?: RequestOptions,
): Promise<Response> {
  const url = typeof url_ === "string" ? new URL(url_) : url_;
  if (url.host === "localhost") {
    url.host = "127.0.0.1";
  }

  const agentOptions = await getAgentOptions(requestOptions);

  // Get proxy from options or environment variables
  const proxy = getProxy(url.protocol, requestOptions);

  // Check if should bypass proxy based on requestOptions or NO_PROXY env var
  const shouldBypass = shouldBypassProxy(url.hostname, requestOptions);

  // Create agent
  const protocol = url.protocol === "https:" ? https : http;
  const agent =
    proxy && !shouldBypass
      ? protocol === https
        ? new HttpsProxyAgent(proxy, agentOptions)
        : new HttpProxyAgent(proxy, agentOptions)
      : new protocol.Agent(agentOptions);

  let headers: { [key: string]: string } = {};

  // Handle different header formats
  if (init?.headers) {
    const headersSource = init.headers as any;

    // Check if it's a Headers-like object (OpenAI v5 HeadersList, standard Headers)
    if (headersSource && typeof headersSource.forEach === "function") {
      // Use forEach method which works reliably on Headers objects
      headersSource.forEach((value: string, key: string) => {
        headers[key] = value;
      });
    } else if (Array.isArray(headersSource)) {
      // This is an array of [key, value] tuples
      for (const [key, value] of headersSource) {
        headers[key] = value as string;
      }
    } else if (headersSource && typeof headersSource === "object") {
      // This is a plain object
      for (const [key, value] of Object.entries(headersSource)) {
        headers[key] = value as string;
      }
    }
  }

  headers = {
    ...headers,
    ...requestOptions?.headers,
  };

  // Replace localhost with 127.0.0.1
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }

  // add extra body properties if provided
  let updatedBody: string | undefined = undefined;
  try {
    if (requestOptions?.extraBodyProperties && typeof init?.body === "string") {
      const parsedBody = JSON.parse(init.body);
      updatedBody = JSON.stringify({
        ...parsedBody,
        ...requestOptions.extraBodyProperties,
      });
    }
  } catch (e) {
    console.log("Unable to parse HTTP request body: ", e);
  }

  const finalBody = updatedBody ?? init?.body;
  const method = init?.method || "GET";

  logLlmWireRequest(method, url, headers, finalBody, proxy, shouldBypass);

  // Verbose logging for debugging - log request details
  if (process.env.VERBOSE_FETCH) {
    logRequest(method, url, headers, finalBody, proxy, shouldBypass);
  }

  // fetch the request with the provided options
  try {
    const resp = await patchedFetch(url, {
      ...init,
      body: finalBody,
      headers: headers,
      agent: agent,
    });

    if (!resp.ok) {
      const requestId = resp.headers.get("x-request-id");
      if (requestId) {
        console.log(`Request ID: ${requestId}, Status: ${resp.status}`);
      }
    }

    return resp;
  } catch (error) {
    // Verbose logging for errors
    if (process.env.VERBOSE_FETCH) {
      logError(error);
    }

    if (error instanceof Error && error.name === "AbortError") {
      // Return a Response object that streamResponse etc can handle
      return new Response(null, {
        status: 499, // Client Closed Request
        statusText: "Client Closed Request",
      });
    }
    throw error;
  }
}
