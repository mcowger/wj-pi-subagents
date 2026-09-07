/**
 * 桥接事件闭集集成测试所用的可脚本 RpcClient 替身。它不访问模型或网络，
 * 仅在 start() 后按脚本顺序把预设事件发给监听者，模拟真实 Pi 的 JSONL 事件流。
 */
export class RpcClient {
  #listeners = new Set();
  #options;

  constructor(options = {}) {
    this.#options = options;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start() {
    // 真实 Pi 的事件在启动完成后随会话产生；延迟确保 start 响应先于事件帧到达父端。
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const event of this.#options.events ?? []) {
      for (const listener of this.#listeners) listener(event);
    }
  }

  async stop() {}

  async send(command) {
    return { type: "response", command: command?.type, success: true };
  }

  async getState() {
    return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  }
}
