import assert from "node:assert/strict";
import test from "node:test";
import {
  getKeybindings,
  Key,
  KeybindingsManager,
  setKeybindings,
} from "@earendil-works/pi-tui";
import {
  expandHintSegments,
  formatExpandKeyText,
} from "../src/expand-hint.ts";

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

test("expand hint follows the host keybinding and formats alternatives", () => {
  const previous = getKeybindings();
  try {
    setKeybindings(new KeybindingsManager({
      "app.tools.expand": {
        defaultKeys: [Key.alt("x"), Key.ctrlShift("e")],
      },
    }));
    const expected = process.platform === "darwin"
      ? "option+x/ctrl+shift+e"
      : "alt+x/ctrl+shift+e";
    assert.equal(formatExpandKeyText(), expected);
    assert.deepEqual(expandHintSegments(theme, "muted", 3), [
      { text: "... (3 more lines,", color: "muted" },
      { text: " ", color: "muted" },
      { text: expected, color: "dim" },
      { text: " to expand)", color: "muted" },
    ]);
  } finally {
    setKeybindings(previous);
  }
});

test("expand hint falls back when the binding is absent or unavailable", () => {
  const previous = getKeybindings();
  try {
    setKeybindings(new KeybindingsManager({}));
    assert.equal(formatExpandKeyText(), "ctrl+o");

    setKeybindings({
      getKeys: () => { throw new Error("keybindings unavailable"); },
    } as unknown as KeybindingsManager);
    assert.equal(formatExpandKeyText(), "ctrl+o");
  } finally {
    setKeybindings(previous);
  }
});
