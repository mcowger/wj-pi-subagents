import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Pi 解析用户级 agent 目录时读取的环境变量键。
 * 与 Pi 的 `ENV_AGENT_DIR`（`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`）一致，APP_NAME 默认为 `pi`。
 */
export const PI_AGENT_DIR_ENV_KEY = "PI_CODING_AGENT_DIR";

/** 与根环境快照相同形态的只读环境输入。 */
export type PiAgentDirEnvironment = Readonly<Record<string, string | number | undefined>>;

function expandHome(value: string): string {
  const home = homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(home, value.slice(2));
  }
  return value;
}

/**
 * 解析用户级 Pi agent 目录，语义与 Pi 的 `getAgentDir()` 对齐：
 * 环境值非空时使用该值（`~` / `~/x` 展开为 home），未设置或空串时回退 `<home>/.pi/agent`。
 *
 * 与 Pi 的唯一差别是返回值始终为绝对路径：相对值按进程 cwd 解析，避免把相对目录带进快照。
 */
export function resolvePiAgentDir(environment?: PiAgentDirEnvironment): string {
  const raw = (environment ?? process.env)[PI_AGENT_DIR_ENV_KEY];
  const value = raw === undefined ? "" : String(raw);
  if (value === "") return join(homedir(), ".pi", "agent");
  return resolve(expandHome(value));
}
