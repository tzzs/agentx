import type { ServerResponse } from "node:http";
import {
  createChatEmitter, dataLine, drain, emitChatError, newUsageCapture,
  reportUsage, usageCapture, withSsePipe, type StreamUsageOptions,
} from "./common.js";
import { jsonRecord, recObj, recObjs, recStr } from "../json.js";

/**
 * Forward a Chat Completions SSE stream byte-for-byte. Used for the local
 * `/v1/chat/completions` endpoint against an upstream whose protocol is
 * already "chat-completions": both sides speak the same grammar, so there is
 * nothing to translate — mirrors `pipeAnthropicPassthrough`/
 * `pipeResponsesPassthrough`'s role for their own native upstreams. Usage
 * only arrives when the caller requested `stream_options.include_usage`; a
 * per-delta count of text chunks backs the `estimated` fallback when it does
 * not.
 */
export async function pipeChatPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const capture = newUsageCapture();
    const usage = usageCapture(capture, options?.protocol ?? "chat-completions", !!options);
    let countedOutput = 0;
    const chunk = createChatEmitter(response, model);
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value || value === "[DONE]") return;
      try {
        const item = jsonRecord(JSON.parse(value));
        const delta = recStr(recObj(recObjs(item, "choices")[0], "delta"), "content");
        if (delta) countedOutput++;
        const itemUsage = recObj(item, "usage");
        if (itemUsage) usage.usage(itemUsage);
      } catch { /* Ignore incomplete provider events. */ }
    };
    try {
      // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
      await drain(reader, consume, (chunkText) => response.write(chunkText));
    } catch (error) {
      emitChatError(response, chunk, error);
    }
    response.end();
    reportUsage(options, { ...capture, output: capture.output || countedOutput }, usage.total());
  });
}
