/**
 * 「一次只能執行一個」的長時間工作（Local 佈版、UpAgent 發佈…）：流程與手動佈版共用同一個 runner。
 * 執行中的資訊（owner + controller）放在 runner.current，查詢狀態 / 停止都透過它。
 * run(..., { wait: true })（手動佈版）在已有工作執行中時排隊，等前面的工作結束依序執行；
 * 不排隊的呼叫（流程）在執行中或有工作排隊時直接丟錯。
 *
 * @param busyMessage (current) => string，已有工作執行中時的錯誤訊息
 */
function createExclusiveRunner(busyMessage) {
  /** 排隊中的工作：{ entry, start }（先進先出） */
  const queue = [];

  /** 釋放執行權：直接交給下一個排隊的工作（中間不會出現空檔讓其他呼叫插隊） */
  function release() {
    const next = queue.shift();
    runner.current = next ? next.entry : null;
    next?.start();
  }

  /** 排隊等到輪到 entry；signal 中止時離開隊伍並丟出「已停止」 */
  function waitTurn(entry, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        reject(new Error('已停止'));
      };
      const waiter = {
        entry,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

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
     * @param wait true = 已有工作執行中時排隊等待（排隊中 signal 中止 = 離開隊伍）；false = 直接丟錯
     * @param onWait (current) => void，開始排隊時呼叫（顯示正在等哪個工作）
     */
    async run(owner, signal, fn, { wait = false, onWait } = {}) {
      if (!wait) runner.assertIdle();
      if (signal?.aborted) throw new Error('已停止');
      const controller = new AbortController();
      const entry = { ...owner, controller };
      if (runner.current) {
        onWait?.(runner.current);
        await waitTurn(entry, signal); // 輪到時 release() 已把 current 設成 entry
        if (signal?.aborted) {
          release();
          throw new Error('已停止');
        }
      } else {
        runner.current = entry;
      }
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort);
      try {
        return await fn(controller.signal, entry);
      } finally {
        signal?.removeEventListener('abort', abort);
        release();
      }
    },

    /** 停止執行中的工作（排隊中的不受影響）；回傳是否有工作在執行 */
    cancel() {
      runner.current?.controller.abort();
      return !!runner.current;
    },
  };
  return runner;
}

module.exports = { createExclusiveRunner };
