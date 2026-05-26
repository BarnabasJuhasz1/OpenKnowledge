from __future__ import annotations
import os
import json
import re
import asyncio
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
from ....models.paper import Paper, Author, PaperVersion
from .base import DatabaseAdapter

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

_PAGE_SIZE = 100  # arXiv max_results per request


def _tokenize(query: str) -> list[str]:
    token_pattern = re.compile(r'"[^"]*"|\(|\)|AND|OR|NOT|[^\s()]+', re.IGNORECASE)
    tokens = []
    for match in token_pattern.finditer(query):
        t = match.group(0)
        if t.startswith('"') and t.endswith('"'):
            tokens.append(t)
        elif t.upper() in ("AND", "OR", "NOT", "(", ")"):
            tokens.append(t.upper())
        else:
            tokens.append(t.lower())
    return tokens


def _make_evaluator(query: str):
    tokens = _tokenize(query)
    if not tokens:
        return lambda doc: True

    operators = {'AND', 'OR', 'NOT', '(', ')'}
    terms = []
    expr_tokens = []
    prev_was_operand_like = False

    for t in tokens:
        is_operand = t not in operators
        if prev_was_operand_like:
            if is_operand or t in ('(', 'NOT'):
                expr_tokens.append('and')

        if t == '(':
            expr_tokens.append('(')
            prev_was_operand_like = False
        elif t == ')':
            expr_tokens.append(')')
            prev_was_operand_like = True
        elif t == 'AND':
            expr_tokens.append('and')
            prev_was_operand_like = False
        elif t == 'OR':
            expr_tokens.append('or')
            prev_was_operand_like = False
        elif t == 'NOT':
            expr_tokens.append('not')
            prev_was_operand_like = False
        else:
            if t.startswith('"') and t.endswith('"'):
                term = t[1:-1].lower()
            else:
                term = t.lower()

            idx = len(terms)
            terms.append(term)
            expr_tokens.append(f"t{idx}")
            prev_was_operand_like = True

    expr_str = ' '.join(expr_tokens)

    # Safe validation of expr_str
    allowed_words = {'true', 'false', 'and', 'or', 'not', '(', ')'}
    words = expr_str.replace('(', ' ( ').replace(')', ' ) ').split()
    for w in words:
        if not w.startswith('t') and w.lower() not in allowed_words:
            raise ValueError(f"Unsafe token detected in query expression: {w}")

    try:
        compiled_expr = compile(expr_str, '<string>', 'eval')
    except Exception:
        return lambda doc: all(term in doc for term in terms)

    def evaluator(doc: str) -> bool:
        env = {f"t{i}": (term in doc) for i, term in enumerate(terms)}
        try:
            return bool(eval(compiled_expr, {"__builtins__": {}}, env))
        except Exception:
            return all(env.values())

    return evaluator


class ArxivAdapter(DatabaseAdapter):
    name = "arxiv"
    rate_limit = 1  # arXiv requires ~3s between requests
    _BASE = "https://export.arxiv.org/api/query"

    async def search(self, query: str) -> list[Paper]:
        # Run file I/O and query scanning off-thread
        return await asyncio.to_thread(self._sync_search, query)

    def _sync_search(self, query: str) -> list[Paper]:
        snapshot_filename = "arxiv-metadata-oai-snapshot.json"
        possible_paths = [
            os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../database", snapshot_filename)),
            os.path.abspath(os.path.join(os.getcwd(), "database", snapshot_filename)),
            os.path.abspath(os.path.join(os.getcwd(), "../database", snapshot_filename)),
            "/home/juhasz/Desktop/Projects/Open_Knowledge/Repo/database/arxiv-metadata-oai-snapshot.json",
        ]

        snapshot_path = None
        for p in possible_paths:
            if os.path.exists(p):
                snapshot_path = p
                break

        if not snapshot_path:
            raise FileNotFoundError(f"Could not locate {snapshot_filename} in any of: {possible_paths}")

        evaluator = _make_evaluator(query)
        matches = []

        with open(snapshot_path, "r", encoding="utf-8") as f:
            for line in f:
                line_lower = line.lower()
                if evaluator(line_lower):
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue

                    title = data.get("title", "")
                    abstract = data.get("abstract", "")
                    if evaluator((title + " " + abstract).lower()):
                        matches.append(data)

        papers = []
        for data in matches:
            base_id = data.get("id", "")

            # Parse authors
            authors = []
            for auth in data.get("authors_parsed", []):
                last_name = auth[0] if len(auth) > 0 else ""
                first_name = auth[1] if len(auth) > 1 else ""
                name = f"{first_name} {last_name}".strip()
                if not name:
                    name = auth[2] if len(auth) > 2 else ""
                if name:
                    authors.append(Author(name=name))

            # Parse categories
            categories = data.get("categories", "").split()

            # Find publication date
            created_v1 = None
            for v in data.get("versions", []):
                if v.get("version") == "v1":
                    created_v1 = v.get("created")
                    break
            if not created_v1 and data.get("versions"):
                created_v1 = data["versions"][0].get("created")

            published_str = None
            year = None
            if created_v1:
                try:
                    dt = parsedate_to_datetime(created_v1)
                    published_str = dt.isoformat().replace("+00:00", "Z")
                    year = dt.year
                except Exception:
                    pass

            if not published_str and data.get("update_date"):
                published_str = data.get("update_date")
                try:
                    year = int(published_str[:4])
                except ValueError:
                    pass

            # Version history
            versions = []
            for v in data.get("versions", []):
                ver_name = v.get("version", "")
                created_raw = v.get("created", "")
                submitted_str = ""
                if created_raw:
                    try:
                        dt = parsedate_to_datetime(created_raw)
                        submitted_str = dt.isoformat().replace("+00:00", "Z")
                    except Exception:
                        submitted_str = created_raw
                versions.append(PaperVersion(version=ver_name, submitted=submitted_str))

            pdf_url = f"https://arxiv.org/pdf/{base_id}"

            papers.append(Paper(
                doi=data.get("doi"),
                arxiv_id=base_id,
                title=data.get("title", "").strip().replace("\n", " "),
                abstract=data.get("abstract", "").strip().replace("\n", " "),
                publication_date=published_str,
                year=year,
                authors=authors,
                journal=data.get("journal-ref"),
                fields_of_study=categories,
                is_open_access=True,
                pdf_url=pdf_url,
                landing_url=f"https://arxiv.org/abs/{base_id}",
                versions=versions if versions else None,
                sources=["arxiv"],
            ))

        return papers

