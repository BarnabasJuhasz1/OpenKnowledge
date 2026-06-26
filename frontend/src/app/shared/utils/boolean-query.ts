/**
 * In-memory boolean-query matcher for title+abstract filtering — the TypeScript
 * mirror of the backend `boolean_query.py` parser/evaluator. Used by the OK-Graph
 * filter so the client matches papers with the SAME boolean semantics as the main
 * search (`AND` / `OR` / `NOT`, `"quoted phrases"`, parentheses, `-term` negation),
 * with precedence `NOT > AND > OR` and an implicit AND between adjacent atoms.
 *
 * A leaf term matches as a case-insensitive substring of the combined
 * "title abstract" haystack (mirroring match_phrase intent: a contiguous phrase).
 */

const OPERATORS = new Set(['AND', 'OR', 'NOT']);

// Quoted phrase, a single parenthesis, or a bare word. Mirrors the Python _TOKEN_RE.
const TOKEN_RE = /"[^"]*"|[()]|[^\s()"]+/g;

type TokenKind = 'AND' | 'OR' | 'NOT' | 'LPAREN' | 'RPAREN' | 'TERM';
interface Token {
  kind: TokenKind;
  value: string;
}

export interface TermNode { type: 'term'; text: string; }
export interface NotNode { type: 'not'; operand: BoolNode; }
export interface BinOpNode { type: 'binop'; op: 'AND' | 'OR'; left: BoolNode; right: BoolNode; }
export type BoolNode = TermNode | NotNode | BinOpNode;

class ParseError extends Error {}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  for (const match of raw.matchAll(TOKEN_RE)) {
    const piece = match[0];
    if (piece === '(') {
      tokens.push({ kind: 'LPAREN', value: piece });
    } else if (piece === ')') {
      tokens.push({ kind: 'RPAREN', value: piece });
    } else if (piece.startsWith('"')) {
      const phrase = piece.slice(1, -1).trim();
      if (phrase) tokens.push({ kind: 'TERM', value: phrase });
    } else if (OPERATORS.has(piece.toUpperCase())) {
      const op = piece.toUpperCase() as TokenKind;
      tokens.push({ kind: op, value: op });
    } else {
      // A bare word may carry leading "-" (e.g. "-RAG") meaning NOT.
      let word = piece;
      while (word.startsWith('-')) {
        tokens.push({ kind: 'NOT', value: 'NOT' });
        word = word.slice(1);
      }
      word = word.trim();
      if (word) tokens.push({ kind: 'TERM', value: word });
    }
  }
  return tokens;
}

// Recursive-descent parser, precedence NOT > AND > OR.
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  parse(): BoolNode {
    if (!this.tokens.length) throw new ParseError('empty');
    const node = this.parseOr();
    if (this.pos !== this.tokens.length) throw new ParseError('trailing tokens');
    return node;
  }

  private parseOr(): BoolNode {
    let node = this.parseAnd();
    let tok: Token | undefined;
    while ((tok = this.peek()) && tok.kind === 'OR') {
      this.pos++;
      node = { type: 'binop', op: 'OR', left: node, right: this.parseAnd() };
    }
    return node;
  }

  private parseAnd(): BoolNode {
    let node = this.parseNot();
    let tok: Token | undefined;
    while ((tok = this.peek()) && (tok.kind === 'AND' || tok.kind === 'NOT' || tok.kind === 'TERM' || tok.kind === 'LPAREN')) {
      if (tok.kind === 'AND') this.pos++; // explicit AND; otherwise implicit
      node = { type: 'binop', op: 'AND', left: node, right: this.parseNot() };
    }
    return node;
  }

  private parseNot(): BoolNode {
    const tok = this.peek();
    if (tok && tok.kind === 'NOT') {
      this.pos++;
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): BoolNode {
    const tok = this.peek();
    if (!tok) throw new ParseError('expected term');
    if (tok.kind === 'LPAREN') {
      this.pos++;
      const node = this.parseOr();
      const closing = this.peek();
      if (!closing || closing.kind !== 'RPAREN') throw new ParseError('unbalanced parens');
      this.pos++;
      return node;
    }
    if (tok.kind === 'TERM') {
      this.pos++;
      return { type: 'term', text: tok.value };
    }
    throw new ParseError(`unexpected ${tok.kind}`);
  }
}

/**
 * Parse a boolean query string into an AST. Returns `null` for an empty,
 * whitespace-only, or syntactically invalid query — callers treat `null` as a
 * match-everything filter no-op (a malformed filter must never empty the graph).
 */
export function parseBooleanQuery(raw: string): BoolNode | null {
  if (!raw || !raw.trim()) return null;
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  try {
    return new Parser(tokens).parse();
  } catch {
    return null;
  }
}

function evalNode(node: BoolNode, haystack: string): boolean {
  switch (node.type) {
    case 'term':
      return haystack.includes(node.text.toLowerCase());
    case 'not':
      return !evalNode(node.operand, haystack);
    case 'binop': {
      const left = evalNode(node.left, haystack);
      const right = evalNode(node.right, haystack);
      return node.op === 'AND' ? left && right : left || right;
    }
  }
}

/** Match a pre-lowercased-or-raw text against a parsed AST. `null` AST => true. */
export function matchesBooleanQuery(text: string, ast: BoolNode | null): boolean {
  if (!ast) return true;
  return evalNode(ast, text.toLowerCase());
}

/**
 * Compile a boolean query string once into a predicate over a node-like object's
 * title + abstract. An empty/invalid query yields a match-everything predicate.
 */
export function compileNodePredicate(
  raw: string,
): (n: { title?: string | null; abstract?: string | null }) => boolean {
  const ast = parseBooleanQuery(raw);
  if (!ast) return () => true;
  return (n) => evalNode(ast, `${n.title ?? ''} ${n.abstract ?? ''}`.toLowerCase());
}
