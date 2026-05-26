from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

from .db.database import init_db
from .api.retrieval import router as retrieval_router
from .api.scoring import router as scoring_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


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

app.include_router(retrieval_router, prefix="/api")
app.include_router(scoring_router, prefix="/api")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
