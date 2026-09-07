const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_MARK_PATTERN = /^\p{Mark}$/u;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PATTERN = /\p{Regional_Indicator}/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu;

export type UiPanelLineStyle = "header" | "body" | "terminal" | "error" | "footer";

interface UiPanelTheme {
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

/** 计算无 ANSI 文本的终端列宽，避免按 UTF-16 单元切断 Unicode 字符。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(value)) width += graphemeWidth(segment);
  return width;
}

/** 超宽时保留一个省略号，并始终在字素簇边界截断。 */
export function truncateToDisplayWidth(value: string, width: number): string {
  if (!Number.isSafeInteger(width) || width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const available = width - 1;
  let used = 0;
  let output = "";
  for (const { segment } of SEGMENTER.segment(value)) {
    const next = graphemeWidth(segment);
    if (used + next > available) break;
    output += segment;
    used += next;
  }
  return `${output}…`;
}

/** 将外部可命名事实约束为单行纯文本，阻断 ANSI、换行与方向控制注入。 */
export function safeUiFact(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, " ").replace(/ {2,}/g, " ").trim();
}

export function themeFg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.fg !== "function") return text;
  try {
    const styled = candidate.fg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function themeBg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.bg !== "function") return text;
  try {
    const styled = candidate.bg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function themeBold(theme: unknown, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.bold !== "function") return text;
  try {
    const styled = candidate.bold.call(candidate, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function padToDisplayWidth(value: string, width: number): string {
  const truncated = truncateToDisplayWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - displayWidth(truncated)))}`;
}

export function stylePanelText(value: string, style: UiPanelLineStyle, theme: unknown): string {
  switch (style) {
    case "header":
      return themeFg(theme, "accent", themeBold(theme, value));
    case "body":
      return themeFg(theme, "customMessageText", value);
    case "error":
      return themeFg(theme, "error", value);
    case "footer":
    case "terminal":
      return themeFg(theme, "dim", value);
  }
}

export function renderPanelRule(
  width: number,
  position: "top" | "divider" | "bottom",
  theme: unknown,
): string {
  const [left, fill, right] = position === "top"
    ? ["┏", "━", "┓"]
    : position === "bottom"
      ? ["┗", "━", "┛"]
      : ["┣", "━", "┫"];
  const color = position === "divider" ? "border" : "borderAccent";
  const rule = `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
  return themeBg(theme, "customMessageBg", themeFg(theme, color, rule));
}

export function renderFramedPanelLine(
  value: string,
  contentWidth: number,
  style: UiPanelLineStyle,
  selected: boolean,
  theme: unknown,
): string {
  const padded = padToDisplayWidth(value, contentWidth);
  const borderColor = style === "header" || selected ? "borderAccent" : "border";
  const line = `${themeFg(theme, borderColor, "┃")} ${stylePanelText(padded, style, theme)} ${themeFg(theme, borderColor, "┃")}`;
  return themeBg(theme, selected ? "selectedBg" : "customMessageBg", line);
}

export function renderNarrowPanelLine(
  value: string,
  width: number,
  style: UiPanelLineStyle,
  selected: boolean,
  theme: unknown,
): string {
  const padded = padToDisplayWidth(value, width);
  return themeBg(
    theme,
    selected ? "selectedBg" : "customMessageBg",
    stylePanelText(padded, style, theme),
  );
}

function graphemeWidth(grapheme: string): number {
  if (EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme) || REGIONAL_INDICATOR_PATTERN.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) width += codePointWidth(character);
  return width;
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || codePoint === 0x200d
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || COMBINING_MARK_PATTERN.test(character)
  ) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
