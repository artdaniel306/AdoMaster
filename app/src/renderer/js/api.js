/** preload 暴露的 API（見 src/preload/index.js）。renderer 只透過這裡和 main process 溝通。 */
export const api = window.api;

/** ipcRenderer.invoke 的錯誤訊息前面會帶 "Error invoking remote method '...': Error: "，去掉後回傳。 */
export function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
