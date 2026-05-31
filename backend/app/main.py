import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from dotenv import load_dotenv

load_dotenv()

from .auth.config import SESSION_SECRET
from .db.database import init_db
from .services import archetype
from .services.archetype.config import load_config as load_archetype_config
from .api.projects import router as projects_router
from .api.keywords import router as keywords_router
from .api.retrieval import router as retrieval_router
from .api.scoring import router as scoring_router
from .api.demo import router as demo_router
from .api.shelf import router as shelf_router
from .api.bookshelf import router as bookshelf_router
from .api.citgraph import router as citgraph_router
from .api.dashboard import router as dashboard_router
from .api.auth import router as auth_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    # Preload the archetype classifier in the background so the model is warm
    # before the first search — the user never waits on the cold model load.
    cfg = load_archetype_config()
    preload_task = None
    if cfg and cfg.get("preload_on_startup", True):
        preload_task = asyncio.create_task(archetype.preload())

    yield

    if preload_task and not preload_task.done():
        preload_task.cancel()
    await archetype.shutdown_worker()


app = FastAPI(
    title="OpenKnowledge API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4201"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Signed-cookie session that carries the logged-in user id. SameSite=Lax is
# enough because the SPA reaches /api through its dev proxy (same origin).
app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="lax",
    https_only=False,
)

app.include_router(projects_router, prefix="/api")
app.include_router(keywords_router, prefix="/api")
app.include_router(retrieval_router, prefix="/api")
app.include_router(scoring_router, prefix="/api")
app.include_router(demo_router, prefix="/api")
app.include_router(shelf_router, prefix="/api")
app.include_router(bookshelf_router, prefix="/api")
app.include_router(citgraph_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")
app.include_router(auth_router, prefix="/api")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
