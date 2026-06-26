"""Safe boolean-query compiler for BigQuery full-text search.

Researchers type traditional boolean queries against academic databases, e.g.::

    "LLM" OR "Large Language Model" AND "compression" NOT "RAG"

This module parses that string into an AST and compiles it into a BigQuery ``WHERE``
expression where every leaf term hits the inverted ``SEARCH()`` indexes on the title
and abstract columns. Crucially, **user text is never concatenated into SQL** — terms
are emitted as bound query parameters (``@t0``, ``@t1`` …) and only the fixed boolean
structure (AND/OR/NOT, parentheses, ``SEARCH(...)``) is generated. This keeps the
query injection-proof while still letting users express arbitrary boolean logic.

Operator precedence follows the usual convention: ``NOT`` binds tighter than ``AND``,
which binds tighter than ``OR``. Adjacent terms with no operator are an implicit AND
(``"a" "b"`` == ``"a" AND "b"``). A ``-term`` / ``-"phrase"`` prefix is sugar for ``NOT``.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

_OPERATORS = {"AND", "OR", "NOT"}


class BooleanQueryError(ValueError):
    """Raised when a boolean query string cannot be parsed."""


# ── Tokenizer ────────────────────────────────────────────────────────────────

@dataclass
class _Token:
    kind: str  # "AND" | "OR" | "NOT" | "LPAREN" | "RPAREN" | "TERM"
    value: str  # for TERM, the literal search phrase


# Matches: a quoted phrase, a single parenthesis, or a bare word. Parens and quotes
# are always delimiters so "(A OR B)" tokenizes cleanly even with no surrounding spaces.
_TOKEN_RE = re.compile(r'"[^"]*"|[()]|[^\s()"]+')


def _tokenize(raw: str) -> list[_Token]:
    tokens: list[_Token] = []
    for match in _TOKEN_RE.finditer(raw):
        piece = match.group(0)
        if piece == "(":
            tokens.append(_Token("LPAREN", piece))
        elif piece == ")":
            tokens.append(_Token("RPAREN", piece))
        elif piece.startswith('"'):
            phrase = piece[1:-1].strip()
            if phrase:
                tokens.append(_Token("TERM", phrase))
        elif piece.upper() in _OPERATORS:
            op = piece.upper()
            tokens.append(_Token(op, op))
        else:
            # A bare word may carry a leading "-" (e.g. "-RAG") meaning NOT.
            word = piece
            while word.startswith("-"):
                tokens.append(_Token("NOT", "NOT"))
                word = word[1:]
            word = word.strip()
            if word:
                tokens.append(_Token("TERM", word))
    return tokens


# ── AST ──────────────────────────────────────────────────────────────────────

@dataclass
class _Term:
    text: str


@dataclass
class _Not:
    operand: object


@dataclass
class _BinOp:
    op: str  # "AND" | "OR"
    left: object
    right: object


# ── Recursive-descent parser (precedence: NOT > AND > OR) ─────────────────────

class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> _Token | None:
        return self._tokens[self._pos] if self._pos < len(self._tokens) else None

    def _advance(self) -> _Token:
        tok = self._tokens[self._pos]
        self._pos += 1
        return tok

    def parse(self) -> object:
        if not self._tokens:
            raise BooleanQueryError("Query is empty.")
        node = self._parse_or()
        if self._pos != len(self._tokens):
            raise BooleanQueryError("Unexpected trailing tokens in query.")
        return node

    def _parse_or(self) -> object:
        node = self._parse_and()
        while (tok := self._peek()) and tok.kind == "OR":
            self._advance()
            right = self._parse_and()
            node = _BinOp("OR", node, right)
        return node

    def _parse_and(self) -> object:
        node = self._parse_not()
        while (tok := self._peek()) and tok.kind in ("AND", "NOT", "TERM", "LPAREN"):
            # Explicit AND, or implicit AND when the next token starts a new atom.
            if tok.kind == "AND":
                self._advance()
            right = self._parse_not()
            node = _BinOp("AND", node, right)
        return node

    def _parse_not(self) -> object:
        if (tok := self._peek()) and tok.kind == "NOT":
            self._advance()
            return _Not(self._parse_not())
        return self._parse_atom()

    def _parse_atom(self) -> object:
        tok = self._peek()
        if tok is None:
            raise BooleanQueryError("Expected a search term but reached end of query.")
        if tok.kind == "LPAREN":
            self._advance()
            node = self._parse_or()
            closing = self._peek()
            if closing is None or closing.kind != "RPAREN":
                raise BooleanQueryError("Unbalanced parentheses in query.")
            self._advance()
            return node
        if tok.kind == "TERM":
            self._advance()
            return _Term(tok.value)
        if tok.kind in ("OR", "AND"):
            raise BooleanQueryError(f"Query has a dangling '{tok.kind}' operator.")
        if tok.kind == "RPAREN":
            raise BooleanQueryError("Unbalanced parentheses in query.")
        raise BooleanQueryError(f"Unexpected token: {tok.value!r}")


# ── Compiler ─────────────────────────────────────────────────────────────────

@dataclass
class CompiledQuery:
    where_sql: str
    parameters: list[tuple[str, str]]  # [(param_name, term_text), ...]


class _Compiler:
    def __init__(self, title_col: str, abstract_col: str) -> None:
        self._title_col = title_col
        self._abstract_col = abstract_col
        self._params: list[tuple[str, str]] = []

    def compile(self, node: object) -> str:
        if isinstance(node, _Term):
            name = f"t{len(self._params)}"
            self._params.append((name, node.text))
            # A term matches if it appears in the title OR the abstract. SEARCH() uses
            # the inverted indexes (papers_title_idx / abstracts_text_idx).
            return (
                f"(SEARCH({self._title_col}, @{name}) "
                f"OR SEARCH({self._abstract_col}, @{name}))"
            )
        if isinstance(node, _Not):
            return f"(NOT {self.compile(node.operand)})"
        if isinstance(node, _BinOp):
            left = self.compile(node.left)
            right = self.compile(node.right)
            return f"({left} {node.op} {right})"
        raise BooleanQueryError("Internal error: unknown AST node.")


def compile_boolean_query(
    raw: str,
    *,
    title_col: str = "title",
    abstract_col: str = "abstract",
) -> CompiledQuery:
    """Compile a boolean query string into a parameterized BigQuery WHERE expression.

    Raises:
        BooleanQueryError: if the query is empty or syntactically invalid.
    """
    if not raw or not raw.strip():
        raise BooleanQueryError("Query is empty.")

    tokens = _tokenize(raw)
    if not tokens:
        raise BooleanQueryError("Query contains no search terms.")

    ast = _Parser(tokens).parse()
    compiler = _Compiler(title_col, abstract_col)
    where_sql = compiler.compile(ast)

    if not compiler._params:
        raise BooleanQueryError("Query contains no search terms.")

    return CompiledQuery(where_sql=where_sql, parameters=compiler._params)


# ── OpenSearch compile target ─────────────────────────────────────────────────
# Same parser/AST, different output: an OpenSearch query DSL dict. Used by the live
# search backend (BigQuery SEARCH() above is kept only for the ingestion/legacy path).

def parse_boolean_query(raw: str) -> object:
    """Parse a boolean query string into its AST root.

    Raises:
        BooleanQueryError: if the query is empty or syntactically invalid.
    """
    if not raw or not raw.strip():
        raise BooleanQueryError("Query is empty.")
    tokens = _tokenize(raw)
    if not tokens:
        raise BooleanQueryError("Query contains no search terms.")
    return _Parser(tokens).parse()


# ── In-memory text predicate target ──────────────────────────────────────────
# Same parser/AST, evaluated directly against a node's title+abstract text. Used by
# the citation-graph filter (client/offline) which needs a `(title, abstract) -> bool`
# predicate rather than a database query. A leaf term matches as a case-insensitive
# substring of the combined "title abstract" haystack — mirroring match_phrase intent
# (a contiguous phrase) and the existing `citgraph_builder.matches_keywords` convention.

def _eval_node(node: object, haystack: str) -> bool:
    if isinstance(node, _Term):
        return node.text.lower() in haystack
    if isinstance(node, _Not):
        return not _eval_node(node.operand, haystack)
    if isinstance(node, _BinOp):
        left = _eval_node(node.left, haystack)
        right = _eval_node(node.right, haystack)
        return (left and right) if node.op == "AND" else (left or right)
    raise BooleanQueryError("Internal error: unknown AST node.")


def compile_text_predicate(raw: str) -> Callable[[str | None, str | None], bool]:
    """Parse ``raw`` once and return a predicate matching a node's title+abstract.

    An empty/whitespace query returns a match-everything predicate (filter no-op).
    A syntactically invalid query also degrades to match-all so a malformed filter
    never silently empties the graph — callers should validate the query separately
    (e.g. surface a UI hint) if they want to reject bad input.
    """
    if not raw or not raw.strip():
        return lambda title, abstract: True
    try:
        ast = parse_boolean_query(raw)
    except BooleanQueryError:
        return lambda title, abstract: True

    def predicate(title: str | None, abstract: str | None) -> bool:
        return _eval_node(ast, f"{title or ''} {abstract or ''}".lower())

    return predicate


def _node_to_opensearch(node: object, fields: tuple[str, ...]) -> dict:
    if isinstance(node, _Term):
        # Match the term in any of the text fields. match_phrase preserves multi-word
        # phrase intent ("large language model"); for a single token it == match.
        return {
            "bool": {
                "should": [{"match_phrase": {f: node.text}} for f in fields],
                "minimum_should_match": 1,
            }
        }
    if isinstance(node, _Not):
        return {"bool": {"must_not": [_node_to_opensearch(node.operand, fields)]}}
    if isinstance(node, _BinOp):
        left = _node_to_opensearch(node.left, fields)
        right = _node_to_opensearch(node.right, fields)
        if node.op == "AND":
            return {"bool": {"must": [left, right]}}
        return {"bool": {"should": [left, right], "minimum_should_match": 1}}
    raise BooleanQueryError("Internal error: unknown AST node.")


def compile_to_opensearch(
    raw: str,
    *,
    fields: tuple[str, ...] = ("title", "abstract"),
) -> dict:
    """Compile a boolean query string into an OpenSearch query DSL dict.

    Each leaf term matches as a phrase in any of ``fields``; AND/OR/NOT map to a
    bool query's must/should/must_not. Raises ``BooleanQueryError`` on bad input.
    """
    ast = parse_boolean_query(raw)
    return _node_to_opensearch(ast, fields)
