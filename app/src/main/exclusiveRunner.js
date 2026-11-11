/**
 * 「一次只能執行一個」的長時間工作（Local 佈版、UpAgent 發佈…）：流程與手動佈版共用同一個 runner。
 * 執行中的資訊（owner + controller）放在 runner.current，查詢狀態 / 停止都透過它。
 *
 * @param busyMessage (current) => string，已有工作執行中時的錯誤訊息
 */
function createExclusiveRunner(busyMessage) {
  const runner = {
    /** 執行中的工作：{ ...owner, controller }；沒有時為 null */
    current: null,

    /** 已有工作執行中就丟錯（開始前的檢查，例如在讀設定之前先擋下） */
    assertIdle() {
      if (runner.current) throw new Error(busyMessage(runner.current));
    },

    /**
     * 佔用 runner 執行 fn(signal, current)，結束（成功 / 失敗）後釋放。
     * @param owner 顯示用的資訊（id、stage、repo…）；fn 可以修改 current（例如目前處理到哪個 repo）
     * @param signal 外部的 AbortSignal（例如手動佈版的停止）；runner.cancel() 也會停止
     */
    async run(owner, signal, fn) {
      runner.assertIdle();
      if (signal?.aborted) throw new Error('已停止');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort);
      runner.current = { ...owner, controller };
      try {
        return await fn(controller.signal, runner.current);
      } finally {
        signal?.removeEventListener('abort', abort);
        runner.current = null;
      }
    },

    /** 停止執行中的工作；回傳是否有工作在執行 */
    cancel() {
      runner.current?.controller.abort();
      return !!runner.current;
    },
  };
  return runner;
}

module.exports = { createExclusiveRunner };
