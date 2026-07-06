import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('returns empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });

  it('escapes HTML so authored markup cannot inject tags', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> & "you"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('renders ATX headings up to level 4', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('#### Deep')).toBe('<h4>Deep</h4>');
    // Five hashes is not a heading — it falls through to a paragraph.
    expect(renderMarkdown('##### Nope')).toContain('<p>');
  });

  it('renders bold and italic, bold winning over italic', () => {
    expect(renderMarkdown('a **bold** b')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('a *italic* b')).toContain('<em>italic</em>');
    expect(renderMarkdown('**x**')).toBe('<p><strong>x</strong></p>');
  });

  it('renders links with target and rel for safety', () => {
    const html = renderMarkdown('See [docs](https://example.com/x).');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener">docs</a>');
  });

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('does not mistake a bare number in prose for inline code', () => {
    // Regression: the inline-code placeholder must not swallow " 2 ".
    const html = renderMarkdown('We are at version 2 of the tool.');
    expect(html).toBe('<p>We are at version 2 of the tool.</p>');
  });

  it('renders inline code without re-processing its contents', () => {
    const html = renderMarkdown('Run `npm **install**` now');
    expect(html).toContain('<code>npm **install**</code>');
    expect(html).not.toContain('<strong>');
  });

  it('renders fenced code blocks verbatim', () => {
    const html = renderMarkdown('```\nline *one*\nline two\n```');
    expect(html).toBe('<pre><code>line *one*\nline two</code></pre>');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted text')).toBe('<blockquote>quoted text</blockquote>');
    expect(renderMarkdown('---')).toBe('<hr />');
  });

  it('splits blank-line-separated paragraphs', () => {
    const html = renderMarkdown('First para.\n\nSecond para.');
    expect(html).toBe('<p>First para.</p>\n<p>Second para.</p>');
  });

  it('joins wrapped lines within a paragraph', () => {
    const html = renderMarkdown('line one\nline two');
    expect(html).toBe('<p>line one line two</p>');
  });
});
