/**
 * 知识库列表可见性：空 default 在工作台与会话范围选择器中都不显示；
 * 其它空库保留（用户可能正要导入），default 一旦有内容就恢复显示。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isListedKb, kbLiveDocs, normalizeScope, visibleKbs } from "../ui/kb-visibility.js";

const emptyDocs = { total: 0, ready: 0, importing: 0, failed: 0, deleted: 0, notes: 0 };

test("kbLiveDocs 兼容对象/数字两种清单形态", () => {
  assert.equal(kbLiveDocs({ docs: emptyDocs }), 0);
  assert.equal(kbLiveDocs({ docs: { ...emptyDocs, ready: 2, notes: 1 } }), 3);
  assert.equal(kbLiveDocs({ docs: 4 }), 4);
  assert.equal(kbLiveDocs({}), 0);
  assert.equal(kbLiveDocs(null), 0);
});

test("空 default 隐藏；其它空库保留；default 有内容恢复显示", () => {
  const list = [
    { name: "default", docs: emptyDocs },
    { name: "标准", docs: emptyDocs },
    { name: "公文", docs: { ...emptyDocs, ready: 1 } },
  ];
  assert.deepEqual(visibleKbs(list).map((kb) => kb.name), ["标准", "公文"]);
  assert.equal(isListedKb({ name: "default", docs: { ...emptyDocs, deleted: 1 } }), true);
  assert.equal(isListedKb({ name: "default", docs: { ...emptyDocs, importing: 1 } }), true);
});

test("visibleKbs 对非数组输入安全返回空数组", () => {
  assert.deepEqual(visibleKbs(undefined), []);
  assert.deepEqual(visibleKbs(null), []);
});

test("normalizeScope 剔除被隐藏的库；只剩隐藏库时回到 none", () => {
  const list = [{ name: "default", dir: "default", docs: emptyDocs }, { name: "标准", dir: "标准", docs: emptyDocs }];
  const visible = visibleKbs(list);
  assert.deepEqual(normalizeScope({ mode: "selected", kbs: ["default"] }, visible), {
    mode: "none",
    kbs: [],
  });
  assert.deepEqual(normalizeScope({ mode: "selected", kbs: ["default", "标准"] }, visible), {
    mode: "selected",
    kbs: ["标准"],
  });
  assert.equal(normalizeScope({ mode: "all", kbs: [] }, visible).mode, "all");
});
