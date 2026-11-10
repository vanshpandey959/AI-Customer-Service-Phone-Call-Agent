# Chandigarh Cafe and Restaurant: AI voice customer service agent

A phone agent that answers a restaurant's calls in **English, Hindi and Punjabi** (and mixed Hindi/English).
It picks up, listens, looks the answer up in the restaurant's knowledge base, and speaks back. Complaints and
feedback are detected during the call and filed, de-duplicated, when it ends. An admin dashboard shows every
call live.

The restaurant is a demo (all details in the knowledge base are fictional). Speech recognition and speech
synthesis come from **Gnani.ai** (Prisma STT, Timbre TTS) through its API.

## How a call flows

```
Caller's phone
     |  (phone network)
   Twilio ---- webhook POST /voice/incoming ----> Node server  (returns <Connect><Stream> TwiML)
     |                                               |
     +---- media stream (WebSocket, 8 kHz audio) ----+   src/voiceStream.js
                                                     |
              Gnani STT  <--- caller's audio --------+
                  |  text + detected language
                  v
              Node  --- POST /ask --->  Python service (FastAPI)
                                          1. embeds the question (multilingual-e5-small)
                                          2. vector search in MongoDB Atlas (knowledge base)
                                          3. Groq gpt-oss-120b writes a short spoken answer
                                             and labels the message complaint / feedback / normal
              Node  <--- answer ------------------+
                  |
              Gnani TTS --- reply audio ---> Twilio ---> caller

Call ends -> Twilio POST /voice/status -> Node asks Python to merge repeated complaints/feedback -> saved in MongoDB
Dashboard (React) -> GET /api/... on the Node server
```

| Part | Folder | Runs on |
|---|---|---|
| Node backend: Twilio webhooks, media-stream voice gateway, call records, dashboard API | `backend-node/` | port 5000 |
| Python RAG service: retrieval + answer generation + complaint merging | `backend-python/` | port 8000 |
| Admin dashboard (React + Vite + Tailwind) | `frontend/` | port 5173 |
| Gnani API checks (standalone) | `tests/` | none |

## Prerequisites

- Node.js 20+, Python 3.11+ (3.13 works), a MongoDB Atlas cluster (the free tier is enough)
- A Twilio account and number (a trial account works), and [ngrok](https://ngrok.com) for the public URL
- A Gnani.ai API key and the name of the voice you chose in its playground
- A Groq API key

## Setup

### 1. Python service and knowledge base

```powershell
cd backend-python
python -m venv cust_service
cust_service\Scripts\activate
pip install -r requirements.txt
copy .env.example .env        # then fill in MONGODB_URI and GROQ_API_KEY
python ingest.py              # loads knowledge/chandigarh_cafe_and_restaurant_kb.md (first run downloads the ~470 MB embedding model)
```

Then, **after** the ingest has created the collection, create the vector index in Atlas
(Atlas Search -> Create Search Index -> Atlas Vector Search -> JSON editor). Database `restaurant_cs`,
collection `knowledge_base`, index name `vector_index`:

```json
{ "fields": [ { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" } ] }
```

Wait until the index status is Active. Check retrieval quality with `python eval_retrieval.py`.

### 2. Node backend

```powershell
cd backend-node
npm install
copy .env.example .env        # fill in MongoDB, Twilio, Gnani values; VOICE_MODE=gnani
```

### 3. Dashboard

```powershell
cd frontend
npm install
copy .env.example .env        # VITE_ADMIN_TOKEN must equal ADMIN_TOKEN in backend-node/.env
```

## Run it (in this order)

1. **Python service**: `cd backend-python`, activate the venv, `uvicorn main:app --port 8000`.
   Wait for `RAG warm-up done` (the model loads once, so the first caller does not wait).
2. **ngrok**: `ngrok http 5000`. Copy the `https://...` address into `PUBLIC_BASE_URL` in `backend-node/.env`.
   The free plan gives a new address every time ngrok restarts.
3. **Node backend**: `cd backend-node`, `npm start`. The console lists the webhook URLs.
4. **Dashboard**: `cd frontend`, `npm run dev`, open http://localhost:5173.
5. **Preflight**: open `http://localhost:5000/voice/selfcheck?token=YOUR_ADMIN_TOKEN` (or without `?token=` if `ADMIN_TOKEN` is empty).
   Every check must say `ok: true`. It tests the webhook through ngrok, the media-stream WebSocket through ngrok,
   the Gnani API key and the Python service, and costs no call credit.
6. **Call**: click *Trigger test call* in the dashboard, answer, press a key at Twilio's trial notice, and talk.

To take calls on your Twilio number instead (Twilio Console -> Phone Numbers -> your number -> Voice configuration):
*A call comes in* -> Webhook -> `https://YOUR-NGROK-URL/voice/incoming` (HTTP POST), and
*Call status changes* -> `https://YOUR-NGROK-URL/voice/status` (HTTP POST). Update both whenever the ngrok URL changes.
On a trial account Twilio only lets you call verified numbers.

## Testing

| Command | What it checks | Needs |
|---|---|---|
| `cd backend-node; npm test` | Gnani clients, audio conversion, the voice gateway (greeting, turns, silence, goodbye, failures), admin token, selfcheck | nothing external (fake Gnani) |
| `node scripts/make-test-questions.js` then `node scripts/simulate-twilio-call.js scripts/out/q-hi.wav` | The whole voice loop without a phone or ngrok | Python service, Node server, Gnani, Groq, Mongo |
| `node scripts/gnani-tts-test.js`, `gnani-stt-test.js <wav>`, `gnani-roundtrip-test.js` | Gnani speech APIs on their own | Gnani key |
| `python eval_retrieval.py` | 30 questions (English, Hindi, Hinglish, Punjabi) find the right knowledge-base chunk | ingested data + index |
| `python eval_answers.py --quick` | Answer language, facts, spoken style and complaint labels per Groq model | Groq key |
| `python latency_probe.py` | Where time goes in one answer (retrieval vs Groq) | Groq key |

## Configuration that matters

| Variable | Where | Purpose |
|---|---|---|
| `VOICE_MODE` | Node | `gnani` (media stream + Gnani) or `twilio` (Twilio's own voice, English only) |
| `PUBLIC_BASE_URL` | Node | the current ngrok https URL; Twilio webhooks are validated against it |
| `ADMIN_TOKEN` / `VITE_ADMIN_TOKEN` | Node / frontend | protects the dashboard API and call triggering; set it before sharing a tunnel |
| `GNANI_API_KEY`, `GNANI_VOICE`, `GNANI_TTS_MODEL` | Node | Gnani credentials, voice name and the model that voice belongs to |
| `GROQ_MODEL` | Python | answer model (`openai/gpt-oss-120b`) |
| `VOICE_SILENCE_TIMEOUT_MS` | Node | silence before "are you still there?" (10 s) |

## Behaviour to know about

- The agent answers in the language of the caller's last sentence. Hindi is spoken from Devanagari and Punjabi from Gurmukhi text.
- It listens only after it has finished speaking: anything said while it is thinking or talking is ignored (no barge-in).
- After 10 s of silence it asks "are you still there?"; after another 10 s it says goodbye and hangs up. Saying "bye" ends the call after the reply.
- If the database is down the call still works (it is not saved). If the Python service fails the agent apologises and keeps listening.
- Free tiers rate-limit: Groq's has a per-minute token limit (our measurements suggested roughly 7,500) and each answer uses about 1,500 tokens, so a very fast back-and-forth can stall briefly.
- The fixed Hindi and Punjabi lines in `backend-node/src/gnani/phrases.js` should be reviewed by a native speaker.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Trial notice, key press, then the call drops | `PUBLIC_BASE_URL` is stale. Update it from the running ngrok, restart Node, run the selfcheck |
| Greeting plays but the agent never answers | Read the `[voice xxxxxx]` lines in the Node console: Python service not running, bad Groq key, or Gnani STT rejected the key |
| Selfcheck: `media-stream-websocket` fails | The tunnel is down or points at the wrong port (`ngrok http 5000`) |
| Selfcheck: `gnani-api` fails with HTTP 401 | `GNANI_API_KEY` is wrong |
| First answer after starting is slow | The Python service was still loading the model: wait for `RAG warm-up done` |
| Dashboard says it couldn't load data | Node is not running, `VITE_ADMIN_TOKEN` does not match `ADMIN_TOKEN`, or the dashboard's address is not in `FRONTEND_ORIGIN` |
| Hindi or Punjabi shows as `????` in PowerShell | Only the console font: the data and the dashboard are fine |

## Project layout

```
backend-node/   server.js, src/voiceStream.js (voice gateway), src/gnani/ (STT/TTS clients, audio, language),
                src/routes/ (voice webhooks, dashboard API), src/models/, scripts/ (test tools), test/
backend-python/ main.py (API), rag.py (retrieval + Groq), ingest.py, text_chunker.py, knowledge/ (the data), eval_*.py
frontend/       React admin dashboard
tests/          standalone Gnani API check
```
