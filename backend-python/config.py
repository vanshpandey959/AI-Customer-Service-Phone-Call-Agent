import os

from dotenv import load_dotenv
from pymongo import MongoClient
from sentence_transformers import SentenceTransformer
from groq import Groq

load_dotenv()


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


MONGODB_URI = _require_env("MONGODB_URI")
MONGODB_DB = os.getenv("MONGODB_DB", "restaurant_cs")
MONGODB_COLLECTION = os.getenv("MONGODB_COLLECTION", "knowledge_base")
VECTOR_INDEX_NAME = os.getenv("VECTOR_INDEX_NAME", "vector_index")

GROQ_API_KEY = _require_env("GROQ_API_KEY")
# gpt-oss-120b passed every check in eval_answers.py (language, facts, style, complaint/feedback labels).
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

# --- Embeddings ---
# multilingual-e5-small understands English, Hindi and Punjabi in one vector
# space, so a Hindi/Punjabi question can match the English menu text.
# Output size is 384. If you switch to a model with a different output size
# (e.g. multilingual-e5-base = 768), set EMBEDDING_DIMENSIONS to match AND
# recreate the Atlas vector index with the same numDimensions.
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "384"))

# e5 models were trained with "query: " / "passage: " prefixes and give worse
# results without them. Other model families need no prefix.
_is_e5 = "e5" in EMBEDDING_MODEL_NAME.lower()
QUERY_PREFIX = os.getenv("EMBEDDING_QUERY_PREFIX", "query: " if _is_e5 else "")
PASSAGE_PREFIX = os.getenv("EMBEDDING_PASSAGE_PREFIX", "passage: " if _is_e5 else "")

# --- Shared clients (loaded once, reused across requests) ---

_mongo_client: MongoClient | None = None
_embedding_model: SentenceTransformer | None = None
_groq_client: Groq | None = None


def get_mongo_client() -> MongoClient:
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = MongoClient(MONGODB_URI)
    return _mongo_client


def get_collection():
    client = get_mongo_client()
    return client[MONGODB_DB][MONGODB_COLLECTION]


def get_embedding_model() -> SentenceTransformer:
    global _embedding_model
    if _embedding_model is None:
        # Downloads the model from HuggingFace on first run, then caches it locally.
        _embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    return _embedding_model


def embed_passages(texts: list[str], show_progress_bar: bool = False) -> list[list[float]]:
    """Embed knowledge-base chunks (used at ingest time)."""
    model = get_embedding_model()
    vectors = model.encode(
        [PASSAGE_PREFIX + t for t in texts],
        batch_size=16,
        normalize_embeddings=True,
        show_progress_bar=show_progress_bar,
    )
    return vectors.tolist()


def embed_query(text: str) -> list[float]:
    """Embed a customer question (used at search time)."""
    model = get_embedding_model()
    vector = model.encode(QUERY_PREFIX + text, normalize_embeddings=True)
    return vector.tolist()


def get_groq_client() -> Groq:
    global _groq_client
    if _groq_client is None:
        # A caller is waiting on the line: give up after 15 s (and retry once) instead of the
        # library's default of 60 s with two retries, which would leave minutes of silence.
        _groq_client = Groq(api_key=GROQ_API_KEY, timeout=15.0, max_retries=1)
    return _groq_client