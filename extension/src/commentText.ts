import * as vscode from 'vscode';

/** Escape untrusted guide text while allowing the comment panel to wrap it. */
export function appendReviewText(markdown: vscode.MarkdownString, text: string): vscode.MarkdownString {
  const escaped = new vscode.MarkdownString().appendText(text);
  // appendText encodes ordinary spaces as non-breaking HTML entities. Preserve
  // its Markdown escaping and line breaks, but let prose wrap at word boundaries.
  markdown.appendMarkdown(escaped.value.replace(/&nbsp;/g, ' '));
  return markdown;
}
