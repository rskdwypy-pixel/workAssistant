/**
 * 真函数测试：需求（story）后端——表单选项解析与固定枚举
 *   - parseSelectOptions 从禅道直出的 <select> HTML 抽选项（值 / 标签 / 是否选中）
 *     用贴近 ZenTao 18.3 真实结构的 fixture（含 name="reviewer[]" 的方括号、selected、分组前缀）
 *   - 分类 / 来源 / 优先级固定枚举形态正确
 * 写操作（createStory/editStory/deleteStory）依赖禅道会话，放到联调实测，不在此单测。
 */
import { parseSelectOptions, STORY_CATEGORY, STORY_SOURCE, STORY_PRI } from '../src/services/storyService.js';

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };

// 贴近真实的建单表单片段（多个 select，含方括号 name、selected、人员分组前缀、干扰文本）
const FORM = `
<form method="post">
  <select name="product" class="form-control">
    <option value="24">QC Stock</option>
    <option value="20" selected>iOS移动端</option>
    <option value="7">安卓移动端</option>
  </select>
  <select name="module"><option value="0">/</option></select>
  <select multiple name="reviewer[]" id="reviewer">
    <option value="">　</option>
    <option value="luotw">L:罗天文</option>
    <option value="wangrui" selected>W:王锐</option>
  </select>
  <select name="assignedTo">
    <option value="">　</option>
    <option value="lijc" selected>L:李佳成</option>
    <option value="nuanshu">N:何俞龙</option>
  </select>
  <select name="pri"><option value="1">1</option><option value="3" selected>3</option></select>
</form>`;

// product
const products = parseSelectOptions(FORM, 'product');
check('product：解析出 3 个产品', products.length === 3, products.map(p => p.value).join(','));
check('product：值与标签正确', products[0].value === '24' && products[0].label === 'QC Stock');
check('product：识别 selected', products.find(p => p.value === '20').selected === true && products[0].selected === false);

// reviewer[]（方括号 name）
const reviewers = parseSelectOptions(FORM, 'reviewer[]');
check('reviewer[]：方括号 name 能命中（空白占位项被丢弃）', reviewers.length === 2, reviewers.map(r => r.value).join(','));
check('reviewer[]：识别已选（王锐）', reviewers.find(r => r.value === 'wangrui').selected === true);
check('reviewer[]：不含空值占位项', !reviewers.some(r => r.value === ''));

// assignedTo
const assignees = parseSelectOptions(FORM, 'assignedTo');
check('assignedTo：识别已选（李佳成）', assignees.find(a => a.value === 'lijc').selected === true);

// pri
const pris = parseSelectOptions(FORM, 'pri');
check('pri：两项且 3 为已选', pris.length === 2 && pris.find(p => p.value === '3').selected === true);

// 不存在的 select → 空数组（上层据此走兜底）
check('缺失的 select 返回空数组', parseSelectOptions(FORM, 'nope').length === 0);
check('空 HTML 返回空数组', parseSelectOptions('', 'product').length === 0);

// 固定枚举
check('分类枚举含 feature/功能', STORY_CATEGORY.some(c => c.value === 'feature' && c.label === '功能') && STORY_CATEGORY.length === 7);
check('来源枚举含 customer/客户', STORY_SOURCE.some(s => s.value === 'customer' && s.label === '客户'));
check('优先级枚举为 1~4', STORY_PRI.map(p => p.value).join(',') === '1,2,3,4');

console.log(`\n需求后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
