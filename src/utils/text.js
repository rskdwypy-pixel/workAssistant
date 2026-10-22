/**
 * 禅道接口返回的文字（标题、名称）是 HTML 转义过的：' → &#039;、" → &quot;、> → &gt;……
 * 直接存下来，插件里就显示成 `$waitTextList([&#039;搜索&#039;…`。读进来时统一还原成原文。
 * &amp; 最后处理，避免把 &amp;lt; 这类「原文就是 &lt;」的文字多还原一层。
 */
function decodeZentaoText(value) {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
    .replace(/&amp;/g, '&');
}

export { decodeZentaoText };
