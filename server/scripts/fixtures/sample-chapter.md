# Chapter 7 — Retrieval-Augmented Generation

## 7.1 Why a model needs a library

A language model knows what it absorbed during training and nothing else. Ask it
about your company's refund policy, a paper published last week, or the dose
recorded in a particular ledger, and it will do the one thing it is built to do:
produce the most plausible continuation. Plausible is not the same as true. The
model has no way to signal the difference, because from the inside, recalling a
fact and inventing one feel identical.

Retrieval-augmented generation, usually shortened to RAG, is the obvious repair.
Before the model answers, we look the answer up. We keep the documents in a
store, fetch the passages that look relevant to the question, paste them into the
prompt, and ask the model to answer *from those passages*. The model stops being
the library and becomes the reader.

This buys three things. Knowledge can be updated by editing documents instead of
retraining. Answers can cite where they came from. And a question with no
supporting document becomes visible as a gap rather than disguised as an answer.

## 7.2 Chunking: where the scissors fall

Documents are too long to retrieve whole, so we cut them into chunks and index
each one. A chunk is the smallest unit retrieval can hand to the model, and that
single sentence explains most of what goes wrong in practice.

Cut too small and a fact stops fitting inside one chunk. Suppose a ledger reads
"the Archivist recorded a dose of forty milligrams, taken at dusk." A forty-word
cut can land between "forty" and "milligrams". Retrieval then works perfectly —
it returns the chunk that matches the question — and the answer is still wrong,
because the chunk it returned contains half a fact. Worse, the model rarely
stops at the gap. Handed "a dose of forty", it completes the sentence the way
such sentences usually end.

Cut too large and the opposite failure appears. A five-hundred-word chunk about
the scriptorium contains the dose, but also candle counts, vellum deliveries and
stair repairs. The embedding that represents it is an average of all of that, so
it matches the question weakly and may not be retrieved at all. When it is, the
relevant sentence is one line in a wall of text.

Overlap is the standard insurance. By letting consecutive chunks share their
last and first few dozen words, a fact severed by one cut survives intact in its
neighbour. Overlap costs storage and some duplicate retrieval; it is almost
always worth it.

There is no universally correct chunk size. The useful question is not "what
size is best" but "how long is the typical fact in this corpus, and does a chunk
reliably contain one".

## 7.3 Retrieval and the top-k budget

Each chunk is embedded into a vector, and the question is embedded the same way.
Retrieval returns the k chunks whose vectors sit closest to the question's. That
number k is a budget, and it is tempting to read it as a quality dial: if three
chunks give a decent answer, surely eight give a better one.

They usually do not. Every chunk admitted to the prompt is a chunk the model is
permitted to believe. Raising k from three to eight on a question about dosage
pulls in the old superseded standard, a passage about a different chapter house
that measures in grains, and a rule about halving doses for younger readers. All
are topically relevant. None answers the question. The model, trying to be
helpful, weaves them together, and the result is an answer that is fluent,
detailed, and contaminated with claims nobody asked about.

Reranking is the usual fix. A first pass retrieves generously — say thirty
candidates — and a second, more expensive model scores each candidate against
the question directly rather than by vector distance. Only the top three survive
into the prompt. The budget stays small; the odds that the right passage is
inside it go up. Fewer, better passages beat more, noisier ones, almost always.

## 7.4 Grounding: checking the answer, not the vibe

Retrieval decides what the model *could* say. Grounding asks what it *did* say.

The distinction matters because a well-retrieved context does not guarantee a
supported answer. Every passage can be relevant, and the answer can still carry
a sentence that no passage supports — a date inferred, a causal link invented, a
number carried over from a neighbouring fact. A confident tone is not evidence.

So grounding is checked per claim. Split the answer into its individual
assertions and, for each, ask whether some retrieved passage supports it. An
assertion that cannot point at a passage is a guess, and should be struck or
flagged no matter how reasonable it sounds. This is also what makes citations
worth more than decoration: a citation attached to each claim turns grounding
from a judgement about the whole answer into something a reader can check one
sentence at a time.

A practical evaluation habit follows. Keep a small set of questions with known
answers and known supporting passages. For each run, record three numbers: did
the gold passage get retrieved at all, did the answer contain the required
facts, and did it contain anything unsupported. The three fail independently,
and a system that only measures the last one will keep mistaking a lucky guess
for understanding.
