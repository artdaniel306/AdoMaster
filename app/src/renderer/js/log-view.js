/** 保留在畫面上的輸出行數上限 */
export const LOG_MAX_LINES = 3000;

/**
 * 背景工作的輸出區（<pre>）：只保留最後 maxLines 行；使用者捲到底時才自動捲動，往上捲閱讀時不打斷。
 * @param pre 顯示輸出的元素（append 時會取消 hidden）
 * @param opts.visible () => boolean，false 時只累積不繪製（例如收合的 <details>）
 */
export function createLogView(pre, { maxLines = LOG_MAX_LINES, visible = () => true } = {}) {
  let lines = [];

  function render() {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = lines.join('\n');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function trim() {
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  }

  return {
    get length() {
      return lines.length;
    },
    append(line) {
      lines.push(line);
      trim();
      pre.hidden = false;
      if (visible()) render();
    },
    /** 換成另一份輸出（省略 = 清空） */
    reset(next = []) {
      lines = [...next];
      trim();
      pre.textContent = lines.join('\n');
    },
    render,
    scrollToEnd() {
      pre.scrollTop = pre.scrollHeight;
    },
  };
}
