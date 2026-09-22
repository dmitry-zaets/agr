import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewHtml, summaryExcerpt } from '../../../extension/src/overview';
test('overview renders rich Markdown while blocking HTML, commands, and embedded images', () => {
  const html = overviewHtml('<Title>', 'scope', '## Heading\n\n- **Bold** and `code`\n\n[PR](https://github.com/a/b/pull/1)\n\n[bad](command:doBad)\n<script>alert(1)</script>\n![image](https://tracking.test/i)');
  assert.ok(html.includes('<h2>Heading</h2>'));
  assert.ok(html.includes('<strong>Bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('href="https://github.com/a/b/pull/1"'));
  assert.ok(!html.includes('href="command:'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.equal(summaryExcerpt('**Hello** [PR](https://github.com)'), 'Hello PR');
});
