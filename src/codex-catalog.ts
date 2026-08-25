import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./fsutil.js";
import { allModels } from "./providers/registry.js";
import type { ProviderModel } from "./providers/types.js";

/** Location of the generated Codex model catalog (overridable for tests). */
export function codexCatalogPath(): string {
  return process.env.AGENTX_CODEX_CATALOG_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentx", "codex-models.json");
}

/**
 * Codex validates catalog files strictly (unknown or missing fields abort the
 * launch), so entries carry exactly the key set verified against codex-cli
 * 0.149.1. Real limits come from the upstream registry when known; unknown
 * models keep conservative defaults — an underestimated window only triggers
 * earlier compaction, while an overestimated one fails mid-run.
 */
function catalogEntry(model: ProviderModel, priority: number) {
  return {
    slug: model.model,
    display_name: model.model,
    description: `${model.model} served through the AgentX local adapter (${model.provider}).`,
    context_window: model.contextWindow ?? 131072,
    max_context_window: model.contextWindow ?? 131072,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    max_output_tokens: model.maxOutputTokens ?? 16384,
    input_modalities: model.modalities?.length ? model.modalities : ["text"],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    shell_type: "shell_command",
    tool_mode: null,
    truncation_policy: { mode: "tokens", limit: 10000 },
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: "low",
    use_responses_lite: false,
    multi_agent_version: "v2",
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    comp_hash: "3000",
    reasoning_summary_format: "experimental",
    default_reasoning_summary: "none",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Light reasoning" },
      { effort: "high", description: "Deep reasoning" },
    ],
    visibility: "list",
    minimal_client_version: "0.144.0",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    model_messages: {
      instructions_template: "You are Codex, an agent powered by the model provided through the local adapter.",
      instructions_variables: { personality_default: "", personality_friendly: "", personality_pragmatic: "" },
      approvals: null,
    },
    experimental_supported_tools: [],
    supports_search_tool: false,
    default_service_tier: null,
    supports_reasoning_summaries: true,
  };
}

export function buildCodexCatalog(models: ProviderModel[] = allModels): string {
  const unique = models.filter((model, index) => models.findIndex((other) => other.model === model.model) === index);
  const catalog = { models: unique.map(catalogEntry) };
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/**
 * Write the catalog consumed via Codex's `model_catalog_json` option so
 * registry models resolve with real metadata instead of the "fallback model
 * metadata" warning. Returns the written path, or undefined when the write
 * fails — Codex still works, it merely warns.
 */
export async function writeCodexCatalog(models: ProviderModel[] = allModels): Promise<string | undefined> {
  if (!models.length) return undefined;
  const file = codexCatalogPath();
  try {
    await atomicWriteFile(file, buildCodexCatalog(models));
    return file;
  } catch {
    return undefined;
  }
}
