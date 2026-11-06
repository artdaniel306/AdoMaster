const { node, chrome, electron } = window.api.versions;
document.getElementById('versions').textContent =
  `Node ${node} · Chromium ${chrome} · Electron ${electron}`;

let count = 0;
const countEl = document.getElementById('count');
document.getElementById('inc').addEventListener('click', () => (countEl.textContent = ++count));
document.getElementById('dec').addEventListener('click', () => (countEl.textContent = --count));

const labels = { platform: '作業系統', arch: '架構', cpus: 'CPU 核心數', memoryGB: '記憶體 (GB)', hostname: '主機名稱' };
document.getElementById('load').addEventListener('click', async () => {
  const info = await window.api.getSystemInfo();
  const ul = document.getElementById('info');
  ul.replaceChildren(
    ...Object.entries(info).map(([k, v]) => {
      const li = document.createElement('li');
      li.textContent = `${labels[k] ?? k}：${v}`;
      return li;
    })
  );
});
