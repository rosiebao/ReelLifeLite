import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromEnv, fromIni } from '@aws-sdk/credential-providers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { router: authRouter } = require('../frontend/auth');
const { router: conversationsRouter } = require('../frontend/conversations');
const { router: familyRouter } = require('../frontend/family');
const { router: friendsRouter } = require('../frontend/friends');
const { router: storiesRouter } = require('../frontend/stories');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine environment mode
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

console.log(`🌍 Environment: ${NODE_ENV}`);
console.log(`📦 Mode: ${IS_PRODUCTION ? 'Production (IAM Role)' : 'Development (config.json)'}`);

// Load configuration
let config;
const configPath = path.join(__dirname, '../../config.json');

if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  console.log('✅ Loaded config.json');
} else {
  // Default config for production
  config = {
    aws: {
      region: process.env.AWS_REGION || 'us-east-1',
    },
    anthropic: {
      modelId: process.env.ANTHROPIC_MODEL_ID || 'us.anthropic.claude-sonnet-5',
      maxTokens: parseInt(process.env.MAX_TOKENS) || 2048,
    },
    server: {
      port: parseInt(process.env.PORT) || 3000,
      cors: {
        origin: process.env.CORS_ORIGIN || 'http://localhost:8000',
        credentials: true,
      },
    },
  };
  console.log('⚙️  Using environment variables');
}

// Initialize Express app
const app = express();
const PORT = config.server.port || 3000;

// Middleware
app.use(cors(config.server.cors));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Mount the app's real authenticated API routes that were previously living in
// src/frontend. This keeps the frontend and backend in sync while serving the
// app from the actual server entry point.
app.use(authRouter);
app.use(conversationsRouter);
app.use(familyRouter);
app.use(friendsRouter);
app.use(storiesRouter);

// Serve the frontend assets from the actual app directories. The app pages now
// live in ../frontend/public (see src/frontend/README.md) -- ../frontend/pages
// no longer holds any of them, so it must not be the starting page.
app.use('/public', express.static(path.join(__dirname, '../frontend/public')));
app.use('/pages', express.static(path.join(__dirname, '../frontend/pages')));
app.use('/images', express.static(path.join(__dirname, '../frontend/images')));
// The interview page (public/interview.html) loads its client from
// ../js/interview.js, which resolves to /js/... -- so this directory has to be
// mounted too or the page comes up with no InterviewClient at all.
app.use('/js', express.static(path.join(__dirname, '../frontend/js')));

// Starting page: /public/index.html is the profile/home page, which itself
// bounces signed-out visitors to /public/login.html (see public/profile.js).
// Redirect instead of serving it at "/" so the page's relative links
// (style.css, profile.jpg, login.html, ...) keep resolving inside /public.
app.get('/', (_req, res) => res.redirect('/public/index.html'));

// Initialize AWS Bedrock client with appropriate credentials
let bedrockClient;

try {
  if (IS_PRODUCTION) {
    // Production Mode: Use IAM Role (EC2 instance profile, ECS task role, etc.)
    console.log('🔐 Using IAM Role credentials (production mode)');
    bedrockClient = new BedrockRuntimeClient({
      region: config.aws.region,
      // Credentials automatically loaded from IAM role
      // Works with: EC2 instance profiles, ECS task roles, Lambda execution roles
    });
  } else {
    // Development Mode: Multiple credential sources (priority order)

    // 1. Check for bearer token (session token) in environment
    if (process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_SESSION_TOKEN) {
      console.log('🎫 Using AWS bearer token from environment variables');
      const sessionToken = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_SESSION_TOKEN;
      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: sessionToken,
        },
      });
    }
    // 2. Check for bearer token in config.json
    else if (config.aws.credentials && config.aws.credentials.sessionToken) {
      console.log('🎫 Using AWS session token from config.json');
      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region,
        credentials: {
          accessKeyId: config.aws.credentials.accessKeyId,
          secretAccessKey: config.aws.credentials.secretAccessKey,
          sessionToken: config.aws.credentials.sessionToken,
        },
      });
    }
    // 3. Standard credentials from config.json
    else if (config.aws.credentials && config.aws.credentials.accessKeyId) {
      console.log('🔑 Using credentials from config.json (development mode)');
      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region,
        credentials: {
          accessKeyId: config.aws.credentials.accessKeyId,
          secretAccessKey: config.aws.credentials.secretAccessKey,
        },
      });
    }
    // 4. Standard credentials from environment variables
    else if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      console.log('🔑 Using credentials from environment variables');
      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region,
        credentials: fromEnv(),
      });
    }
    // 5. Default credential chain (AWS CLI, ~/.aws/credentials)
    else {
      console.log('🔑 Using default credential chain (AWS CLI, ~/.aws/credentials)');
      bedrockClient = new BedrockRuntimeClient({
        region: config.aws.region,
        credentials: fromIni(),
      });
    }
  }
  console.log('✅ AWS Bedrock client initialized');
} catch (error) {
  console.error('❌ Failed to initialize Bedrock client:', error.message);
  process.exit(1);
}

// Store active interview sessions (in production, use a database)
const interviewSessions = new Map();

// The interviewer's system prompt per interview mode. Shared by /start and
// /resume, so a resumed interview keeps the voice it started with.
const INTERVIEW_SYSTEM_PROMPTS = {
  'Life Period': 'You are a compassionate interviewer helping someone document memories from a specific period of their life. Ask thoughtful, open-ended questions that encourage detailed storytelling. Focus on emotions, sensory details, and significant moments. Keep questions concise and conversational.',
  'Major Event': 'You are conducting an oral history interview about a major life event. Ask questions that help the person explore the before, during, and after of this event, including how it changed them. Be empathetic and allow them to share at their own pace.',
  'Journey': 'You are interviewing someone about a meaningful journey or experience. Ask about their motivations, challenges faced, people encountered, and what they learned along the way. Encourage vivid storytelling with sensory details.',
  'Relationship': 'You are helping someone preserve memories of an important relationship. Ask about how they met, memorable moments together, what they learned from this person, and the lasting impact. Be warm and encourage emotional honesty.',
  'Wisdom': 'You are conducting a legacy interview focused on life lessons and wisdom. Ask about key learnings, advice for future generations, values that guided them, and what they hope others will remember. Help them articulate their insights clearly.',
};

// Upper bound on the saved exchange a resume can replay into a session.
const MAX_RESUME_HISTORY = 400;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ReelLife API is running',
    mode: IS_PRODUCTION ? 'production' : 'development',
    environment: NODE_ENV,
  });
});

// Environment info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    environment: NODE_ENV,
    mode: IS_PRODUCTION ? 'production (IAM Role)' : 'development (config.json)',
    region: config.aws.region,
    model: config.anthropic.modelId,
    version: '1.0.0',
  });
});

// Start a new interview session
app.post('/api/interview/start', async (req, res) => {
  try {
    const { mode, userId } = req.body;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const systemPrompt = INTERVIEW_SYSTEM_PROMPTS[mode] || INTERVIEW_SYSTEM_PROMPTS['Life Period'];

    // Initialize session
    const session = {
      id: sessionId,
      mode,
      userId,
      systemPrompt,
      conversationHistory: [],
      created: new Date().toISOString(),
    };

    interviewSessions.set(sessionId, session);

    // Generate first question
    const firstQuestion = await generateQuestion(sessionId, null);

    res.json({
      success: true,
      sessionId,
      question: firstQuestion,
    });
  } catch (error) {
    console.error('Error starting interview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start interview',
      message: error.message,
    });
  }
});

// Resume a recorded interview: a new session seeded with the saved exchange
// (the Story tab keeps every question and answer -- see
// public/interviewStorage.js), so the next question follows on from what was
// already said instead of starting the story over.
app.post('/api/interview/resume', async (req, res) => {
  try {
    const { mode, history } = req.body;

    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ success: false, error: 'history must be a non-empty array' });
    }
    if (history.length > MAX_RESUME_HISTORY) {
      return res.status(400).json({ success: false, error: `history is limited to ${MAX_RESUME_HISTORY} entries` });
    }
    const conversationHistory = [];
    for (const entry of history) {
      if (!entry || !['assistant', 'user'].includes(entry.role)
          || typeof entry.content !== 'string' || !entry.content.trim()) {
        return res.status(400).json({
          success: false,
          error: 'each history entry needs a role (assistant or user) and non-empty content',
        });
      }
      conversationHistory.push({ role: entry.role, content: entry.content, timestamp: new Date().toISOString() });
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const session = {
      id: sessionId,
      mode,
      systemPrompt: INTERVIEW_SYSTEM_PROMPTS[mode] || INTERVIEW_SYSTEM_PROMPTS['Life Period'],
      conversationHistory,
      created: new Date().toISOString(),
    };
    interviewSessions.set(sessionId, session);

    const question = await generateQuestion(
      sessionId,
      null,
      "We're picking this interview back up after a break. Welcome me back in one short sentence, then ask the next question -- build on what I've already told you and don't repeat anything you've already asked."
    );

    res.json({ success: true, sessionId, question });
  } catch (error) {
    console.error('Error resuming interview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resume interview',
      message: error.message,
    });
  }
});

// Send user response and get next question
app.post('/api/interview/respond', async (req, res) => {
  try {
    const { sessionId, response } = req.body;

    if (!interviewSessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    const session = interviewSessions.get(sessionId);
    if (typeof response !== 'string' || !response.trim()) {
      return res.status(400).json({ success: false, error: 'response must be a non-empty string' });
    }

    // Add user response to history
    session.conversationHistory.push({
      role: 'user',
      content: response,
      timestamp: new Date().toISOString(),
    });

    // Generate next question
    const nextQuestion = await generateQuestion(sessionId, response);

    res.json({
      success: true,
      question: nextQuestion,
      conversationLength: session.conversationHistory.length,
    });
  } catch (error) {
    console.error('Error processing response:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process response',
      message: error.message,
    });
  }
});

// End interview and get transcript
app.post('/api/interview/end', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!interviewSessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    const session = interviewSessions.get(sessionId);

    const story = await generateStory(session);
      const meta = await generateMetadata(story, session.created).catch(err => {
        console.error('Metadata generation failed:', err);
        return { title: null, location: null, period: null };
      });

      res.json({
        success: true,
        title: meta.title || `${session.mode} Chapter`,
        location: meta.location,
        period: meta.period,
        recordedAt: session.created,
        transcript: session.conversationHistory,
        story,
        duration: calculateDuration(session),
      });


    // Clean up session
    interviewSessions.delete(sessionId);
  } catch (error) {
    console.error('Error ending interview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end interview',
      message: error.message,
    });
  }
});

// Generate question using Claude. `instruction` overrides the usual "what next"
// nudge -- /resume uses it to have the interviewer pick the thread back up.
async function generateQuestion(sessionId, userResponse, instruction = null) {
  const session = interviewSessions.get(sessionId);

  // Build conversation for Claude
  const messages = [];

  // Add conversation history
  session.conversationHistory.forEach(entry => {
    messages.push({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: entry.content,
    });
  });

  // Add instruction for next question
  if (instruction) {
    messages.push({ role: 'user', content: instruction });
  } else if (session.conversationHistory.length === 0) {
    messages.push({
      role: 'user',
      content: 'Please ask me the first question to begin my story.',
    });
  } else {
    messages.push({
      role: 'user',
      content: 'Based on my previous response, what would you like to know next?',
    });
  }

  // Prepare request for Bedrock
  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: config.anthropic.maxTokens,
    thinking: { type: 'disabled' },
    // temperature: config.anthropic.temperature,
    // top_p: config.anthropic.topP,
    system: session.systemPrompt,
    messages: messages,
  };

  const command = new InvokeModelCommand({
    modelId: config.anthropic.modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const textBlock = responseBody.content.find(b => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`No text block in response (stop_reason=${responseBody.stop_reason}, blocks=${responseBody.content.map(b => b.type).join(',')})`);
  }
  const question = textBlock.text;

  // Store assistant's question in history
  session.conversationHistory.push({
    role: 'assistant',
    content: question,
    timestamp: new Date().toISOString(),
  });

  return question;
}

// Generate story from conversation
async function generateStory(session) {
  // Create a summary prompt
  const transcript = session.conversationHistory
    .map(entry => `${entry.role === 'assistant' ? 'Interviewer' : 'Storyteller'}: ${entry.content}`)
    .join('\n\n');

  const messages = [
    {
      role: 'user',
      content: `Please transform the following interview transcript into a compelling first-person narrative story. Maintain the emotional tone, include the vivid details the storyteller gave, and organize it into coherent paragraphs. The story should read like a personal memoir chapter.\n\nTranscript:\n${transcript}\n\nPlease write the story now:`,
    },
  ];
  const recordedLabel = new Date(session.created).toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    thinking: { type: 'disabled' },
    // temperature: 0.7,
    system: `You are a skilled memoir writer who transforms interview transcripts into beautiful, flowing first-person narratives. You preserve the authentic voice and emotions while crafting a compelling story. Do not include a title or any markdown headings — begin directly with the prose. This interview was recorded on ${recordedLabel}. Use that date only to resolve relative time references the storyteller makes ("yesterday", "last summer", "three years ago"). 
    Never invent a date, weekday, month, year, place name, or person's name that the storyteller did not state and that cannot be derived from the recording date. If the storyteller was vague, stay vague — write "the day before" rather than naming a weekday.`,
    messages: messages,
  };

  const command = new InvokeModelCommand({
    modelId: config.anthropic.modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return responseBody.content[0].text;
}

 // Extract chapter metadata from the finished story
  async function generateMetadata(story, recordedAt) {
    const recordedLabel = new Date(recordedAt).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      thinking: { type: 'disabled' },
      system: `You extract metadata from memoir chapters. Reply with a single JSON object and nothing else — no markdown fences, no commentary.

  Schema: {"title": string, "location": string|null, "period": string|null}

  - title: an evocative chapter title, 3-8 words, no quotation marks or trailing punctuation.
  - location: where the events happen, named as the storyteller would (e.g. "Seattle", "rural Ohio"). null if never stated.
  - period: when the events happen (e.g. "March 1998", "the summer of 1985"). null if never stated.
  - The chapter was recorded on ${recordedLabel}. Resolve relative references
    ("yesterday", "last month") against that date. Still use null if the
    storyteller gave no time reference at all.

  Never guess or invent location or period. If the storyteller did not say, use null.`,
      messages: [{ role: 'user', content: `Memoir chapter:\n\n${story}` }],
    };

    const command = new InvokeModelCommand({
      modelId: config.anthropic.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const raw = responseBody.content.find(b => b.type === 'text')?.text?.trim() ?? '';

    try {
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
      return { title: str(parsed.title), location: str(parsed.location), period: str(parsed.period) };
    } catch {
      console.error('Could not parse metadata JSON:', raw);
      return { title: null, location: null, period: null };
    }
  }

// Calculate interview duration
function calculateDuration(session) {
  if (session.conversationHistory.length === 0) return 0;

  const start = new Date(session.created);
  const end = new Date();
  const durationMs = end - start;

  return Math.floor(durationMs / 1000); // Return seconds
}

// Start server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 ReelLife API Server Started');
  console.log('='.repeat(60));
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`📦 Mode: ${IS_PRODUCTION ? 'Production (IAM Role)' : 'Development (config.json)'}`);
  console.log(`📍 AWS Region: ${config.aws.region}`);
  console.log(`🤖 Model: ${config.anthropic.modelId}`);
  console.log(`🔒 Auth: ${IS_PRODUCTION ? 'IAM Role' : 'Static Credentials'}`);
  console.log('='.repeat(60));
  console.log('✅ Ready to conduct interviews with Claude!');
  console.log('='.repeat(60) + '\n');
});