import type { ServerResponse } from "node:http";
import {
  dataLine, drain, emitResponsesError, event, newUsageCapture, reportUsage,
  usageCapture, withSsePipe, type StreamUsageOptions,
} from "./common.js";

/**
 * Forward a Responses-protocol SSE stream byte-for-byte. Usage is captured from
 * `response.completed` and reported through `onUsage`; the local client sees
 * the same events the upstream emitted.
 */
export async function pipeResponsesPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const capture = newUsageCapture();
    const usage = usageCapture(capture, options?.protocol ?? "responses", !!options);
    let outputTokens = 0;
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value || value === "[DONE]") return;
      try {
        const item = JSON.parse(value);
        if (item.type === "response.output_text.delta" && typeof item.delta === "string") outputTokens++;
        if (item.response?.usage) usage.usage(item.response.usage);
      } catch { /* Ignore incomplete provider events. */ }
    };
    try {
      // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
      await drain(reader, consume, (chunk) => response.write(chunk));
    } catch (error) {
      emitResponsesError(response, `resp_${crypto.randomUUID()}`, model, error);
    }
    response.end();
    reportUsage(options, { ...capture, output: capture.output || outputTokens }, usage.total());
  });
}
