import { $ } from './dom.js';
import { createIterationTree } from './iteration-tree.js';
import { createWorkItemsView } from './work-items.js';
import { createRequirementFlowView } from './requirement-flow.js';

const exactEl = $('exact');
const views = {
  flow: { view: createRequirementFlowView(), panel: $('view-flow'), loadedKey: null },
  items: { view: createWorkItemsView(), panel: $('view-items'), loadedKey: null },
};
let current = 'flow';

/** 目前分頁若還沒載入過這個 Iteration（或「不含子 Iteration」有變）才重新查詢 */
function refresh(force = false) {
  const node = tree.getSelected();
  if (!node) return;
  const key = `${node.iterationPath}|${exactEl.checked}`;
  const v = views[current];
  if (!force && v.loadedKey === key) return;
  v.loadedKey = key;
  v.view.show(node, exactEl.checked);
}

const tree = createIterationTree({
  onSelect: (node) => {
    $('wi-title').textContent = node.name;
    $('wi-sub').textContent = node.iterationPath + (node.startDate ? `　(${node.startDate} ~ ${node.finishDate})` : '');
    refresh(true);
  },
});

exactEl.addEventListener('change', () => refresh());

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    current = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const [name, v] of Object.entries(views)) v.panel.hidden = name !== current;
    refresh();
  });
}

tree.load();
