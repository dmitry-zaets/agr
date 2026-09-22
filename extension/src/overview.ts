// Bundled into the extension; raw HTML and embedded images are disabled.
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false }).disable('image');
markdown.validateLink = (url: string) => /^(https?:\/\/|mailto:|#)/i.test(url);
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function summaryExcerpt(summary: string): string {
  const tokens = markdown.parse(summary, {});
  const text = tokens.flatMap((t: any) => t.children ? t.children.map((c: any) => c.content || ' ') : (t.type === 'fence' || t.type === 'code_block') ? [t.content] : []).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? text.slice(0, 177) + '…' : text;
}
export function overviewHtml(title: string, scope: string, summary: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);padding:20px 28px;max-width:850px;line-height:1.6}h1{font-size:1.5em}h2{margin-top:1.6em}a{color:var(--vscode-textLink-foreground)}pre{overflow:auto;padding:12px;background:var(--vscode-textCodeBlock-background)}code{font-family:var(--vscode-editor-font-family)}blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);margin-left:0;padding-left:16px}table{border-collapse:collapse}td,th{padding:6px 12px;border:1px solid var(--vscode-panel-border)}.scope{color:var(--vscode-descriptionForeground);margin-bottom:28px}</style></head><body><h1>${escape(title)}</h1><p class="scope">${escape(scope)}</p>${markdown.render(summary)}</body></html>`;
}
