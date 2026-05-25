from .openalex import OpenAlexAdapter
from .semantic_scholar import SemanticScholarAdapter
from .arxiv import ArxivAdapter
from .europe_pmc import EuropePmcAdapter
from .dblp import DblpAdapter
from .crossref import CrossRefAdapter
from .core import CoreAdapter
from .pubmed import PubMedAdapter

ALL_ADAPTERS = [
    OpenAlexAdapter,
    SemanticScholarAdapter,
    ArxivAdapter,
    EuropePmcAdapter,
    DblpAdapter,
    CrossRefAdapter,
    CoreAdapter,
    PubMedAdapter,
]

ADAPTER_MAP = {cls.name: cls for cls in ALL_ADAPTERS}
