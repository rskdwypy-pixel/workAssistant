/**
 * 把 console 的普通日志改道到 stderr。
 * MCP 的 stdio 传输用 stdout 承载 JSON-RPC 协议，任何多余的 stdout 输出都会破坏协议。
 * 必须在导入 zentaoService / config（它们会 console.log）之前调用。
 */
const toStderr = (...args) => {
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
};

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
// console.error / console.warn 保留原样（本就走 stderr）

export {};
