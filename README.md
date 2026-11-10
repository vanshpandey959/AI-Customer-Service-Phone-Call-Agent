# Restaurant Customer Service Agent — Phase 1

A RAG-powered customer service chatbot for a restaurant (sample data:
"Spice Route Kitchen"), built as three independent services:

```
project/
├── backend-python/   FastAPI — RAG logic (embeddings, vector search, Groq LLM). Stateless.
├── backend-node/     Express — session/history management, the API the frontend talks to.
└── frontend/         React + Vite + Tailwind v4 — a call-simulator chat UI.
```

## Why three services

- **`backend-python`** is the "brain" — it embeds text, runs MongoDB vector
  search, and calls Groq. It's intentionally stateless: send it a message
  (+ conversation history), get back an answer. No memory of its own.
- **`backend-node`** is the "memory and orchestration" layer — it owns
  conversation history per session, and is what the frontend actually
  talks to. In a later phase, this is also where Twilio webhooks, call
  transcripts, complaints/feedback, and customer identity will live.
- **`frontend`** simulates what a caller would experience, as a chat UI,
  so you can test and demo the agent without needing a real phone call.

Keeping these separate (rather than one big app) means each can be
deployed, scaled, and redeployed independently, and it matches the natural
split between "AI logic" (Python's strength) and "stateful backend +
webhooks" (Node, which you're more comfortable in).

## Local development setup

Run all three in order (each in its own terminal):

**1. Python RAG service**
```bash
cd backend-python
python3 -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in MONGODB_URI and GROQ_API_KEY
python ingest.py       # one-time: embeds the sample knowledge base into MongoDB
uvicorn main:app --reload --port 8000
```

**2. Node backend**
```bash
cd backend-node
npm install
cp .env.example .env   # defaults already point at localhost:8000 and :5173
npm run dev
```

**3. Frontend**
```bash
cd frontend
npm install
cp .env.example .env   # defaults already point at localhost:5000
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`) and start
chatting. See each service's own README/`.env.example` for details —
`backend-python/README.md` has the MongoDB Atlas Vector Search index setup.

## Deploying — order and env var wiring

The three services reference each other by URL, so deploy in this order
and update env vars as you go:

**Step 1 — Deploy `backend-python`** (e.g. Render, Railway, Fly.io — pick
one with a generous free tier; see the RAM note below)
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Env vars: `MONGODB_URI`, `MONGODB_DB`, `MONGODB_COLLECTION`,
  `VECTOR_INDEX_NAME`, `GROQ_API_KEY`, `GROQ_MODEL`, `EMBEDDING_MODEL`
- Note the deployed URL, e.g. `https://your-rag-service.onrender.com`

**Step 2 — Deploy `backend-node`** (e.g. Render)
- Build command: `npm install`
- Start command: `npm start`
- Env vars: `PYTHON_SERVICE_URL` = the URL from Step 1, `FRONTEND_ORIGIN`
  = your frontend's URL (see Step 3 — you may need to update this after
  Step 3 and redeploy). Most platforms auto-inject `PORT`, so leave it
  unset unless your host requires setting it explicitly.
- Note the deployed URL, e.g. `https://your-node-backend.onrender.com`

**Step 3 — Deploy `frontend`** (e.g. Vercel, Netlify)
- Build command: `npm run build`, output directory: `dist`
- Env var: `VITE_API_URL` = the URL from Step 2. **Vite bakes env vars in
  at build time**, so set this in your host's project settings *before*
  the first build, or trigger a rebuild after changing it.
- Once deployed, go back to `backend-node`'s env vars and set
  `FRONTEND_ORIGIN` to this URL, then redeploy `backend-node` so CORS
  allows requests from it.

This circular dependency (Node needs the frontend's URL, frontend needs
Node's URL) is normal — just expect one redeploy of `backend-node` after
the frontend is live.

## ⚠️ Free-tier RAM warning for `backend-python`

`sentence-transformers` pulls in PyTorch, which is a large dependency —
loading it plus the embedding model typically uses 300–500MB of RAM. Many
free-tier hosts (e.g. Render's free web service tier) cap RAM around
512MB, which puts you right at the edge and can cause out-of-memory
crashes on deploy, especially if MongoDB/FastAPI overhead pushes it over.

If you hit this:
- Try it first — `all-MiniLM-L6-v2` is a small model and it may fit fine,
  especially with nothing else running on the instance.
- If it OOMs, the cleanest fix is switching `backend-python` to call the
  **HuggingFace Inference API** for embeddings instead of running the
  model locally — this removes the PyTorch dependency entirely from your
  deployed service (much smaller footprint, no local model loading). I
  can help you make this swap if you run into this — it's a small change
  isolated to `config.py` and the embedding calls in `ingest.py`/`rag.py`.
- Alternatively, look at hosts with a bit more free-tier RAM (Railway's
  free tier, Fly.io's free allowance) as a first attempt before
  refactoring.

## What's next (Phase 2+)

- Twilio webhooks in `backend-node` (incoming call → speech-to-text →
  call `backend-python` → text-to-speech reply)
- MongoDB collections in `backend-node` for call transcripts, complaints,
  feedback, and customer identity (lookup by phone number)
- Swap the in-memory session store (`backend-node/src/sessionStore.js`)
  for a MongoDB-backed one, so history survives restarts
