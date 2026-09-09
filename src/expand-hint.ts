import { getKeybindings } from "@earendil-works/pi-tui";
import type {
  AgentToolRenderTheme,
  SafeRenderSegment,
} from "./agent-tool-rendering.ts";

const FALLBACK_EXPAND_KEY = "ctrl+o";

/** Read the host's current expand binding and format it like Pi's TUI hints. */
export function formatExpandKeyText(): string {
  try {
    const keys = getKeybindings().getKeys("app.tools.expand");
    if (!Array.isArray(keys) || keys.length === 0) return FALLBACK_EXPAND_KEY;
    return keys
      .map((key) => key
        .split("+")
        .map((part) => process.platform === "darwin" && part.toLowerCase() === "alt"
          ? "option"
          : part)
        .join("+"))
      .join("/");
  } catch {
    return FALLBACK_EXPAND_KEY;
  }
}

/** Build the separately styled parts shared by tool and custom-message hints. */
export function expandHintSegments(
  theme: AgentToolRenderTheme,
  bodyColor: Parameters<AgentToolRenderTheme["fg"]>[0],
  hiddenLines: number,
): readonly SafeRenderSegment[] {
  void theme;
  return Object.freeze([
    { text: `... (${hiddenLines} more lines,`, color: bodyColor },
    { text: " ", color: bodyColor },
    { text: formatExpandKeyText(), color: "dim" },
    { text: " to expand)", color: bodyColor },
  ]);
}
