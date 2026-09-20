import type { ServerResponse } from "node:http";
import {
  dataLine, drain, emitAnthropicError, newUsageCapture, reportUsage,
  usageCapture, withSsePipe, type StreamUsageOptions,
} from "./common.js";
import { jsonRecord, recObj } from "../json.js";

/**
 * Forward a native Anthropic Messages SSE stream byte-for-byte. Used for
 * Claude Code against a custom provider whose protocol is "anthropic": both
 * sides already speak the same event grammar, so there's nothing to
 * translate — this mirrors `pipeResponsesPassthrough`'s role for a
 * Responses-native upstream. Usage arrives split across two events:
 * `message_start` carries the initial input token count, `message_delta`
 * carries the final output token count (and cache token fields) once the
 * turn completes.
 */
export async function pipeAnthropicPassthrough(upstream: Response, response: ServerResponse, _model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const capture = newUsageCapture();
    const usage = usageCapture(capture, options?.protocol ?? "anthropic", !!options);
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value) return;
      try {
        const item = jsonRecord(JSON.parse(value));
        if (item.type === "message_start") { const startUsage = recObj(recObj(item, "message"), "usage"); if (startUsage) usage.usage(startUsage); }
        // message_delta is the turn's final usage; presence of options gates
        // capture exactly as before (no options → nothing to report to).
        if (item.type === "message_delta") { const deltaUsage = recObj(item, "usage"); if (deltaUsage && options) usage.usage(deltaUsage); }
      } catch { /* Ignore incomplete provider events. */ }
    };
    try {
      // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
      await drain(reader, consume, (chunk) => response.write(chunk));
    } catch (error) {
      emitAnthropicError(response, error);
    }
    response.end();
    reportUsage(options, capture);
  });
}
