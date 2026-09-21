import * as vscode from 'vscode';

/** Escape untrusted guide prose, letting the panel wrap each paragraph. */
export function appendReviewText(markdown: vscode.MarkdownString, text: string): vscode.MarkdownString {
  // Escape paragraphs separately: appendText turns each newline into a paragraph
  // break. Authored single newlines are only wrapping hints, not blank lines.
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n(?:[ \t]*\n)*/);
  markdown.appendMarkdown(paragraphs.map(paragraph => {
    const prose = paragraph.replace(/[ \t]*\n[ \t]*/g, ' ');
    return new vscode.MarkdownString().appendText(prose).value.replace(/&nbsp;/g, ' ');
  }).join('\n\n'));
  return markdown;
}
