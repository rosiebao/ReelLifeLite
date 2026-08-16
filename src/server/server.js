import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromEnv, fromIni } from '@aws-sdk/credential-providers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Serve static files (HTML, CSS, JS, images)
app.use(express.static(path.join(__dirname, '../..')));

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

    // Create system prompt based on interview mode
    const systemPrompts = {
      'Life Period': 'You are a compassionate interviewer helping someone document memories from a specific period of their life. Ask thoughtful, open-ended questions that encourage detailed storytelling. Focus on emotions, sensory details, and significant moments. Keep questions concise and conversational.',
      'Major Event': 'You are conducting an oral history interview about a major life event. Ask questions that help the person explore the before, during, and after of this event, including how it changed them. Be empathetic and allow them to share at their own pace.',
      'Journey': 'You are interviewing someone about a meaningful journey or experience. Ask about their motivations, challenges faced, people encountered, and what they learned along the way. Encourage vivid storytelling with sensory details.',
      'Relationship': 'You are helping someone preserve memories of an important relationship. Ask about how they met, memorable moments together, what they learned from this person, and the lasting impact. Be warm and encourage emotional honesty.',
      'Wisdom': 'You are conducting a legacy interview focused on life lessons and wisdom. Ask about key learnings, advice for future generations, values that guided them, and what they hope others will remember. Help them articulate their insights clearly.',
    };

    const systemPrompt = systemPrompts[mode] || systemPrompts['Life Period'];

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

    // Generate story from conversation
    const story = await generateStory(session);

    res.json({
      success: true,
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

// Generate question using Claude
async function generateQuestion(sessionId, userResponse) {
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
  if (session.conversationHistory.length === 0) {
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
    temperature: config.anthropic.temperature,
    top_p: config.anthropic.topP,
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

  const question = responseBody.content[0].text;

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
      content: `Please transform the following interview transcript into a compelling first-person narrative story. Maintain the emotional tone, include vivid details, and organize it into coherent paragraphs. The story should read like a personal memoir chapter.\n\nTranscript:\n${transcript}\n\nPlease write the story now:`,
    },
  ];

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.7,
    system: 'You are a skilled memoir writer who transforms interview transcripts into beautiful, flowing first-person narratives. You preserve the authentic voice and emotions while crafting a compelling story.',
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