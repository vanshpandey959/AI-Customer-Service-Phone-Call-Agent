"""
Ingests the restaurant knowledge base into MongoDB with multilingual embeddings.

Usage:
    python ingest.py                                   # default knowledge file
    python ingest.py knowledge/chandigarh_cafe_and_restaurant_kb.md
    python ingest.py --reset                           # delete EVERYTHING in the collection first

Order matters on a fresh database: run this first (it creates the collection),
THEN create the Atlas vector search index.
"""

import sys
from pathlib import Path

from config import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL_NAME,
    MONGODB_COLLECTION,
    MONGODB_DB,
    embed_passages,
    get_collection,
)
from text_chunker import chunk_markdown

DEFAULT_FILE = "knowledge/chandigarh_cafe_and_restaurant_kb.md"
CHUNK_SIZE = 700  # characters, heading path included


def ingest(file_path: str, reset: bool = False) -> None:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Knowledge base file not found: {file_path}")

    text = path.read_text(encoding="utf-8")
    chunks = chunk_markdown(text, chunk_size=CHUNK_SIZE)
    print(f"Split '{path.name}' into {len(chunks)} chunks.")

    collection = get_collection()
    print(f"Target: {MONGODB_DB}.{MONGODB_COLLECTION}")

    if reset:
        deleted = collection.delete_many({})
        print(f"--reset: removed {deleted.deleted_count} existing documents.")
    else:
        deleted = collection.delete_many({"source": path.name})
        if deleted.deleted_count:
            print(f"Removed {deleted.deleted_count} previously ingested chunks for this file.")

        # Vectors from different embedding models cannot be compared, so leftovers
        # from an old model (or from the old English-only one) would poison search.
        stale = collection.count_documents({"embedding_model": {"$ne": EMBEDDING_MODEL_NAME}})
        if stale:
            print(
                f"WARNING: {stale} documents in this collection were not embedded with "
                f"'{EMBEDDING_MODEL_NAME}'. Re-run with --reset to clear them."
            )

    print(f"Generating embeddings with {EMBEDDING_MODEL_NAME} (first run downloads the model)...")
    embeddings = embed_passages([c["text"] for c in chunks], show_progress_bar=True)

    actual_dims = len(embeddings[0])
    if actual_dims != EMBEDDING_DIMENSIONS:
        raise RuntimeError(
            f"Model produced {actual_dims}-dimensional vectors but EMBEDDING_DIMENSIONS is "
            f"{EMBEDDING_DIMENSIONS}. Fix EMBEDDING_DIMENSIONS and make the Atlas index "
            f"numDimensions match ({actual_dims})."
        )

    docs = [
        {
            "text": chunk["text"],
            "section": chunk["section"],
            "embedding": embedding,
            "embedding_model": EMBEDDING_MODEL_NAME,
            "source": path.name,
            "chunk_index": i,
        }
        for i, (chunk, embedding) in enumerate(zip(chunks, embeddings))
    ]

    result = collection.insert_many(docs)
    print(f"Inserted {len(result.inserted_ids)} documents ({actual_dims} dimensions each).")
    print("Next: make sure the Atlas vector index exists with numDimensions =", actual_dims)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ingest(args[0] if args else DEFAULT_FILE, reset="--reset" in sys.argv)