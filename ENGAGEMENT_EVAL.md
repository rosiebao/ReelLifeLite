# Evaluating User Engagement with the AI Interviewer

A plan for measuring how engaged storytellers are during ReelLife interviews, and for
attributing what we learn back to the interviewer prompts we control.

## Summary

The interview flow already timestamps every turn (`src/server/server.js:224`, `:347`), which is
most of what engagement measurement needs. The work breaks into one prerequisite and three
layers:

| Step | What | Unlocks |
|---|---|---|
| 0 | Persist sessions + detect abandonment | Everything else |
| 1 | Behavioral metrics from timestamps | Objective, free, deterministic signals |
| 2 | Claude-as-judge on the transcript | Qualitative depth of storytelling |
| 3 | Attribute results to prompts | Actionable prompt improvements |

---

## Step 0 — Prerequisite: persist session data

**The blocker.** `interviewSessions` is an in-memory `Map` (`server.js:135`) and the session is
deleted immediately after the response is sent (`server.js:281`). Every transcript is currently
discarded, and a server restart wipes everything in flight. There is no data to evaluate.

Two contained changes:

1. **Write sessions out on end.** In `/api/interview/end`, before the `delete`, append the
   session (transcript + computed metrics) to a store. For local evaluation a single JSON-lines
   file is sufficient:
   ```js
   fs.appendFileSync('sessions.jsonl', JSON.stringify(record) + '\n');
   ```
   Move to a real database when deploying.

2. **Add an abandonment sweeper.** A `setInterval` running every few minutes finds sessions with
   no new turn in ~15 minutes, writes them out flagged `abandoned: true`, and evicts them.

The sweeper matters most: **where people quit is the single most valuable engagement signal**, and
today abandoned sessions leak into the Map invisibly.

---

## Step 1 — Behavioral metrics (no LLM)

Compute these per session at write time.

| Metric | How | Why it matters |
|---|---|---|
| Turns completed | `conversationHistory.length / 2` | Baseline depth |
| Talk ratio | user words ÷ assistant words | Should be **well above 1**. Below 1 means Claude is monologuing, not interviewing |
| Response-length trend | slope of user word count vs. turn index | **Strongest disengagement signal** — steadily shrinking answers indicate fatigue, visible *before* the user quits |
| Response latency | user `timestamp` − preceding assistant `timestamp` | Long gaps suggest a confusing question (or hard thinking — read alongside length) |
| Abandon turn index | from the sweeper | Pinpoints where the prompt loses people |
| Completion rate | completed ÷ (completed + abandoned) | Top-line number |

The slope is worth the five lines:

```js
// user turns only, word counts w[i] at index i
const n = w.length, mx = (n - 1) / 2, my = w.reduce((a, b) => a + b, 0) / n;
const slope = w.reduce((s, y, i) => s + (i - mx) * (y - my), 0)
            / w.reduce((s, _, i) => s + (i - mx) ** 2, 0);
// negative slope = answers shrinking = losing them
```

### Caveat: speech-recognition chunking

`sendResponse` fires on each `isFinal` speech-recognition chunk
(`src/js/interview.js:55-59`), so **one spoken answer can split into several stored "turns."**
Group consecutive user turns separated by less than ~2s before computing any of the above, or
turn counts and response lengths will both be wrong.

---

## Step 2 — Claude as judge on the transcript

`generateMetadata` (`server.js:393`) is already the right pattern: strict JSON out, fenced-code
stripping, safe fallback on parse failure. Clone it as `scoreEngagement(session)` and call it
from `/api/interview/end` alongside the existing metadata call.

Score dimensions that distinguish genuinely engaged storytelling from mere compliance:

```json
{
  "specificity": "1-5, named people/places/dates/sensory detail vs. generic summary",
  "emotional_disclosure": "1-5, shares feeling vs. reports events flatly",
  "volunteered_detail": "1-5, goes beyond what was asked — best engagement proxy there is",
  "friction_markers": ["quotes of \"I don't know\", \"next question\", one-word answers"],
  "question_misses": [
    { "turn": 4, "why": "two questions at once; storyteller answered only the second" }
  ]
}
```

**Require quoted evidence for every score**, not just numbers. It makes the output auditable and
measurably reduces the model rating everything a 4.

### Validate the judge before trusting it

Hand-label 20–30 transcripts on the same 1–5 scales, then check how well Claude's scores
correlate. If they diverge, tighten the rubric with concrete anchors ("a 2 names no people and no
places") rather than accepting the numbers — otherwise we optimize against a metric that doesn't
track what we care about.

---

## Step 3 — Attribute results back to the prompts

This is where evaluation becomes actionable, since the system prompts
(`server.js:166-172`) are the lever we control.

- **Per-question lift.** For each interviewer question, record the word count of the answer it
  produced. Aggregate by question type across sessions to learn which phrasings open people up
  and which shut them down.
- **Compare the five modes.** Life Period, Major Event, Journey, Relationship, and Wisdom are
  five distinct system prompts, already tagged on every session via `session.mode`. The same
  metrics grouped by mode reveal which prompt is weakest. This is a free A/B test that already
  exists in the product.

---

## Recommended order

1. Persist sessions + abandonment sweeper — *unlocks everything else*
2. Layer 1 metrics, including the speech-chunk grouping fix
3. Run ~20 real interviews (self + friends) to build a corpus
4. Add the Layer 2 judge; validate against hand labels
5. Compare across the five modes; revise the weakest prompt

## Scope note

This document covers measuring engagement *of storytellers during interviews*. Using the
interviewer to **conduct research interviews with users about the product** is a different build
and would need a separate plan.
