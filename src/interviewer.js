// The interviewer behind the Story tab: asks the next question and turns a
// finished interview into a first-person story. Ported from the ReelLife
// repo's src/server/server.js, which did the same through AWS Bedrock.
//
// Claude is only called when INTERVIEW_AI=bedrock, normally set in
// frontend/.env (see .env.example), which app.js loads on `npm start`.
// Otherwise -- the default,
// and what the tests run against -- questions come from a short canned list and
// the story is just the user's own answers, which is how the Story tab behaved
// before any AI was wired up. So the app still runs for anyone on the team
// without AWS access.
//
// Bedrock credentials are whatever the AWS SDK finds: AWS_BEARER_TOKEN_BEDROCK,
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY(/AWS_SESSION_TOKEN), or a profile in
// ~/.aws. INTERVIEW_AWS_REGION picks the region, falling back to AWS_REGION /
// AWS_DEFAULT_REGION. It's its own setting because the shell's AWS_REGION is
// often set for something else, wins over .env, and not every region serves
// every model (an account can get "model does not exist" in one region and
// the same model fine in another).
const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");

const USE_BEDROCK = process.env.INTERVIEW_AI === "bedrock";
const MODEL = process.env.INTERVIEW_MODEL || "anthropic.claude-opus-5";
const REGION = process.env.INTERVIEW_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

// The interviewer's main idea and basically the starting phrase that it gives the user
// all ai generated questions btw it knows best frfr
const MODES = {
    Stages: {
        focus:
            "You are helping them document memories from one stage of their life -- a childhood, a school, " +
            "a job, a place they lived. Help them pick the stage, then explore what daily life was like, the " +
            "people around them, and the moments that stand out.",
        opening: "Which stage of your life would you like to talk about today?",
    },
    People: {
        focus:
            "You are helping them preserve memories of someone who mattered to them. Ask how they met, " +
            "moments they shared, what that person taught them, and the mark they left. Be warm, and leave " +
            "room for feelings as well as facts.",
        opening: "Who is someone who mattered to you that you'd like to talk about?",
    },
    Moments: {
        focus:
            "You are helping them tell the story of a memorable moment or event. Explore what led up to it, " +
            "what happened, how it felt at the time, and how it changed things afterwards.",
        opening: "What's a moment from your life that you'd like to tell me about?",
    },
    Lessons: {
        focus:
            "You are helping them put into words the lessons their life has taught them. Ask for the " +
            "experiences behind each lesson, the values that guided them, and what they would want future " +
            "generations to know.",
        opening: "What's a lesson life has taught you that you'd want others to know?",
    },
};
const DEFAULT_MODE = "Stages";

// canned responses for testing purposes when AI deactivated
const FOLLOW_UPS = [
    "That's a great memory -- what happened next?",
    "I'd love to hear more about that. Who else was there?",
    "Thanks for sharing! How did that make you feel at the time?",
    "Interesting -- can you describe the place a bit more?",
    "What do you remember most vividly about that moment?",
];

function interviewerSystemPrompt(mode) {
    return (
        "You are a kind, curious interviewer for ReelLife, an app where people record their life stories " +
        "for their families and future generations. " +
        MODES[mode].focus +
        "\n\nAsk one open-ended question at a time, and build on what they have just told you -- ask about " +
        "people, places, sensory details and feelings. Keep each question short and conversational. Reply " +
        "with the question only: no preamble, no list of options, no commentary on their answer beyond a " +
        "brief, genuine acknowledgement. Their answers may come from speech-to-text, so read past small " +
        "transcription mistakes."
    );
}

const STORY_SYSTEM_PROMPT =
    "You are a memoir writer for ReelLife, an app where people record their life stories for their families " +
    "and future generations. You turn an interview transcript into a first-person story, in the storyteller's " +
    "own voice, and fill in the details of the publish form for it.\n\n" +
    "Faithfulness comes first. Use only what the storyteller actually said: never invent names, dates, places, " +
    "people or events, and leave out anything the interviewer asked that went unanswered. If they were vague, " +
    "stay vague -- write \"the day before\", not a weekday they never named. Their answers may come from " +
    "speech-to-text, so read past small transcription mistakes, but keep their words, tone and the details " +
    "they chose to share. Organize it into flowing paragraphs that read like a memoir chapter.\n\n" +
    "Reply with exactly these tags, in this order, and nothing outside them:\n" +
    "<title>An evocative title, 3-8 words, no quotation marks or trailing punctuation.</title>\n" +
    "<summary>One or two sentences, at most 300 characters, that would draw a family member in.</summary>\n" +
    "<place>Where it happens, as the storyteller named it (\"Seattle\", \"rural Ohio\"). Empty if they never said.</place>\n" +
    "<time_period>When it happens (\"the summer of 1985\", \"1950s-1960s\"). Resolve relative references " +
    "(\"last summer\") against the recording date. Empty if they gave no time reference at all.</time_period>\n" +
    "<tags>Up to 4 short, comma-separated topics (\"Family, Childhood, Food\").</tags>\n" +
    "<story>The story itself: plain text with a blank line between paragraphs -- no title, headings or " +
    "markdown.</story>";

// The details the story comes with, as the publish form names them. Each is
// trimmed to fit the form (see ./stories.js), so a long-winded reply can never
// make publishing fail.
const STORY_FIELDS = ["title", "summary", "place", "time_period", "tags", "story"];

const KICKOFF = "Please ask me the first question to begin my story.";
const SKIP_REQUEST = "I'd rather not answer that one. Could you ask me something different?";

let client = null;

function bedrockClient() {
    if (!client) client = new AnthropicBedrockMantle(REGION ? { awsRegion: REGION } : {});
    return client;
}

// Lets the tests put a stand-in client in front of the Bedrock code path.
function setClientForTests(fakeClient) {
    client = fakeClient;
}

function isBedrockEnabled() {
    return USE_BEDROCK || client !== null;
}

// Thrown for anything that stops the interviewer answering; interview.js turns
// it into a 502/503 rather than the generic 500.
class InterviewerError extends Error {
    constructor(message, { retryable = false, cause } = {}) {
        super(message, { cause });
        this.retryable = retryable;
    }
}

// One line for the startup log, so it's obvious which interviewer is running.
function describe() {
    if (!USE_BEDROCK) {
        return "Interview AI: off, using canned questions (set INTERVIEW_AI=bedrock in .env to use Claude)";
    }
    if (!REGION) {
        return "Interview AI: WARNING -- INTERVIEW_AI=bedrock but no INTERVIEW_AWS_REGION or AWS_REGION is set, so every question will fail";
    }
    return `Interview AI: Claude (${MODEL}) on AWS Bedrock in ${REGION}`;
}

function parseMode(value) {
    return Object.hasOwn(MODES, value) ? value : null;
}

// The interview as Claude sees it: the opening question, then each answer and
// the question that followed it. `prompts` rows are (answer, next question)
// pairs, so a prompt whose response is still NULL -- the question failed to
// generate -- just leaves two answers back to back, which the API accepts.
function interviewMessages(openingQuestion, prompts) {
    const messages = [];
    if (openingQuestion || prompts.length === 0) messages.push({ role: "user", content: KICKOFF });
    if (openingQuestion) messages.push({ role: "assistant", content: openingQuestion });
    for (const prompt of prompts) {
        messages.push({ role: "user", content: prompt.content });
        if (prompt.response) messages.push({ role: "assistant", content: prompt.response });
    }
    return messages;
}

function interviewTranscript(openingQuestion, prompts) {
    const lines = [];
    if (openingQuestion) lines.push(`Interviewer: ${openingQuestion}`);
    for (const prompt of prompts) {
        lines.push(`Storyteller: ${prompt.content}`);
        if (prompt.response) lines.push(`Interviewer: ${prompt.response}`);
    }
    return lines.join("\n\n");
}

async function callClaude({ system, messages, effort }) {
    let response;
    try {
        response = await bedrockClient().messages.create({
            model: MODEL,
            max_tokens: 16000,
            system,
            messages,
            ...(effort ? { output_config: { effort } } : {}),
        });
    } catch (err) {
        const retryable =
            err instanceof AnthropicBedrockMantle.RateLimitError ||
            err instanceof AnthropicBedrockMantle.InternalServerError ||
            err instanceof AnthropicBedrockMantle.APIConnectionError;
        // The usual setup mistake, so the log says how to fix it.
        const hint =
            err.status === 404
                ? ` -- ${MODEL} isn't available to this account in ${REGION}; set INTERVIEW_AWS_REGION ` +
                  "(e.g. us-east-1) or INTERVIEW_MODEL in .env"
                : "";
        throw new InterviewerError(`Bedrock request failed: ${err.message}${hint}`, { retryable, cause: err });
    }

    if (response.stop_reason === "refusal") {
        throw new InterviewerError("Claude declined to respond to this interview");
    }
    // Cut off mid-reply: for a story that means a missing ending, so it's a
    // failure rather than something to hand the storyteller as finished.
    if (response.stop_reason === "max_tokens") {
        throw new InterviewerError("Claude ran out of room before finishing");
    }
    const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    if (!text) throw new InterviewerError(`Claude returned no text (stop_reason: ${response.stop_reason})`);
    return text;
}

// A question is a short, latency-sensitive chat turn, so it runs at low
// effort; the story is the one call worth spending more on.
function askClaude(mode, messages) {
    return callClaude({ system: interviewerSystemPrompt(mode), messages, effort: "low" });
}

function pickFollowUp(avoid) {
    const choices = FOLLOW_UPS.filter((question) => question !== avoid);
    return choices[Math.floor(Math.random() * choices.length)];
}

async function openingQuestion(mode) {
    if (!isBedrockEnabled()) return MODES[mode].opening;
    return askClaude(mode, interviewMessages(null, []));
}

async function nextQuestion(mode, openingQuestion, prompts) {
    if (!isBedrockEnabled()) return pickFollowUp();
    return askClaude(mode, interviewMessages(openingQuestion, prompts));
}

// A different question in place of `skipped`, which is the last thing in the
// interview so far (the opening question, or the latest prompt's response).
async function replacementQuestion(mode, openingQuestion, prompts, skipped) {
    if (!isBedrockEnabled()) return pickFollowUp(skipped);
    return askClaude(mode, [
        ...interviewMessages(openingQuestion, prompts),
        { role: "user", content: SKIP_REQUEST },
    ]);
}

// "Tuesday, June 18, 2026" -- given to Claude so it can place "yesterday" or
// "last summer", never to put a date in the story the storyteller didn't give.
function recordingDate(recordedAt) {
    const date = new Date(recordedAt);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
    });
}

// Pulls the tagged fields out of Claude's reply. Missing or empty fields come
// back as "", and if the <story> tag itself went missing the whole reply,
// minus any tags, is taken as the story rather than losing it.
function parseStoryReply(text) {
    const field = (name) => {
        const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
        return match ? match[1].trim() : "";
    };
    const details = Object.fromEntries(STORY_FIELDS.map((name) => [name, field(name)]));
    if (!details.story && !/<story>/i.test(text)) {
        details.story = text.replace(/<(\w+)>[\s\S]*?<\/\1>/g, "").trim();
    }
    if (!details.story) throw new InterviewerError("Claude's reply had no story in it");
    details.tags = details.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
    return details;
}

// The finished interview as a story plus the details for the publish form:
// { story, title, summary, place, time_period, tags, ai }. `ai` says whether
// Claude wrote it. Without Claude the story is just the storyteller's own
// answers and the details are left for them -- said loudly in the log, since
// from the outside it looks like the story was written.
// `recordedAt` (the conversation's creation date) and `mode` give Claude the
// context the transcript alone doesn't have.
async function draftStory(openingQuestion, prompts, { recordedAt, mode } = {}) {
    if (!isBedrockEnabled()) {
        console.warn(
            "Interview AI is off (INTERVIEW_AI isn't \"bedrock\"), so the story is just the answers joined " +
                "together -- see .env.example to switch Claude on"
        );
        const story = prompts
            .map((prompt) => prompt.content.trim())
            .filter(Boolean)
            .join("\n\n");
        return { story, title: "", summary: "", place: "", time_period: "", tags: [], ai: false };
    }

    const context = [];
    const recorded = recordedAt && recordingDate(recordedAt);
    if (recorded) context.push(`This interview was recorded on ${recorded}.`);
    if (mode && MODES[mode]) context.push(`Interview topic: ${MODES[mode].focus}`);

    const text = await callClaude({
        system: STORY_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content:
                    (context.length ? context.join("\n") + "\n\n" : "") +
                    "Here is the interview transcript. Write the story now.\n\n<transcript>\n" +
                    interviewTranscript(openingQuestion, prompts) +
                    "\n</transcript>",
            },
        ],
    });
    return { ...parseStoryReply(text), ai: true };
}

module.exports = {
    MODES,
    DEFAULT_MODE,
    MODEL,
    InterviewerError,
    describe,
    parseMode,
    interviewMessages,
    openingQuestion,
    nextQuestion,
    replacementQuestion,
    draftStory,
    parseStoryReply,
    setClientForTests,
};
