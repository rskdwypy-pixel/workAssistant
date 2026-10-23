/**
 * 真函数测试：文档中心（后端内容渲染与消毒）
 *   - markdown 文档：渲染成 HTML（标题 / 列表 / 表格 / 粗体 / 链接），不展示源码
 *   - html 文档：原样消毒
 *   - 消毒：去 <script>/onload；内联图 file-read-N 改写为后端代理
 *   - 未知格式：按纯文本兜底
 */
import { renderContent, sanitizeDocHtml } from '../src/services/docService.js';

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };

// markdown 渲染
const md = renderContent('text', 'markdown', '# 标题\n\n**粗** 与 [x](http://a)\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![图](/zentao/file-read-9.png)');
check('markdown：渲染出标题', /<h1>标题<\/h1>/.test(md.contentHtml));
check('markdown：渲染出列表', /<li>一<\/li>/.test(md.contentHtml));
check('markdown：渲染出表格', /<table>/.test(md.contentHtml));
check('markdown：粗体与链接', /<strong>粗<\/strong>/.test(md.contentHtml) && /<a href="http:\/\/a">x<\/a>/.test(md.contentHtml));
check('markdown：内联图改写为后端代理', /<img src="\/api\/zentao\/files\/9\/content\?ext=png"/.test(md.contentHtml));
check('markdown：不输出源码到 contentText', md.contentText === '');

// markdown 里夹带脚本被清除
const evil = renderContent('text', 'md', '正常\n\n<script>alert(1)</script>\n\n<img src=x onerror="hack()">');
check('markdown：<script> 被清除', !/<script/i.test(evil.contentHtml));
check('markdown：onerror 事件属性被清除', !/onerror/i.test(evil.contentHtml));

// html 文档
const html = renderContent('text', 'html', '<p onclick="x()">正文 <img onload="y()" src="/zentao/file-read-12.jpg"></p><script>z()</script>');
check('html：script 块清除', !/<script/i.test(html.contentHtml));
check('html：on* 事件清除', !/onclick|onload/i.test(html.contentHtml));
check('html：内联图改写', /\/api\/zentao\/files\/12\/content\?ext=jpg/.test(html.contentHtml));

// 外链 / 文件型不产出正文
check('非正文型不渲染', renderContent('attachment', 'html', 'x').contentHtml === '' && renderContent('url', 'html', 'x').contentHtml === '');

// 未知格式兜底为纯文本
const plain = renderContent('text', 'raw2', '就是一段文字');
check('未知格式按纯文本兜底', plain.contentText === '就是一段文字' && plain.contentHtml === '');

// sanitizeDocHtml 单独：javascript: 协议
check('sanitize：javascript: 协议被去掉', !/javascript:/i.test(sanitizeDocHtml('<a href="javascript:alert(1)">x</a>')));

console.log(`\n文档中心后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
