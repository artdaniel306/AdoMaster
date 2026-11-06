import { $ } from './dom.js';
import { createIterationTree } from './iteration-tree.js';
import { createWorkItemsView } from './work-items.js';

const exactEl = $('exact');
const workItems = createWorkItemsView();
const tree = createIterationTree({
  onSelect: (node) => workItems.show(node, exactEl.checked),
});

exactEl.addEventListener('change', () => {
  const node = tree.getSelected();
  if (node) workItems.show(node, exactEl.checked);
});

tree.load();
