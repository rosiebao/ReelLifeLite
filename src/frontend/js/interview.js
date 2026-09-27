// ReelLife Interview Client
// Connects to backend API with AWS Bedrock (Anthropic Claude)

// Auto-detect API URL: use current origin in production, localhost in
// development.
//
// Deliberately not named API_BASE_URL: config.js declares that name for the
// same-origin accounts API, and two top-level `const`s of the same name in one
// page is a SyntaxError -- which silently killed this whole file and left the
// interview page with no client at all.
const INTERVIEW_API_BASE_URL = window.location.protocol === 'file:'
? 'http://localhost:3000/api'
: '/api';

// localStorage key for the "read questions aloud" toggle ('on' by default).
const VOICE_PREFERENCE_KEY = 'reellife_voice_questions';

// ---- Microphone tuning ----
// Speech recognition reports an answer as many short "final" phrases. They are
// collected and sent as ONE answer once the storyteller has paused this long,
// instead of one AI call per phrase (which made the interviewer slow and made
// it interrupt people mid-sentence).
const ANSWER_PAUSE_MS = 1500;
// Chrome ends recognition on its own (silence, ~60s limit, network blips).
// It is restarted quickly; real errors back off up to the max.
const RESTART_BASE_DELAY_MS = 150;
const RESTART_MAX_DELAY_MS = 5000;
// Safety net: if listening should be on but isn't (a missed event), restart it.
const WATCHDOG_INTERVAL_MS = 4000;
const START_STUCK_MS = 8000;
// A reply that takes longer than this is treated as failed, so the chat never
// hangs on the "…" indicator.
const RESPONSE_TIMEOUT_MS = 60000;

class InterviewClient {
  constructor() {
    this.sessionId = null;
    this.isRecording = false;
    this.conversationHistory = [];
    this.recognition = null;
    this.microphoneReady = false;
    this.currentTranscript = '';
    this.captionsEnabled = false;
    // The most recent question, plus a hook the hosting page uses to save each
    // exchange (see public/interviewStorage.js). Plain fields on purpose: this
    // client has no storage dependency of its own.
    this.lastQuestion = null;
    this.onTurn = null;

    // Spoken questions (browser text-to-speech). While a question is being
    // read aloud the microphone stops listening, otherwise speech recognition
    // would transcribe the interviewer's own voice as the storyteller's answer.
    this.voiceEnabled = localStorage.getItem(VOICE_PREFERENCE_KEY) !== 'off';
    this.isSpeaking = false;
    // Kept referenced until they finish: Chrome can garbage-collect an
    // utterance mid-sentence and then never fire its onend.
    this.activeUtterances = [];
    // A question the browser refused to play because nobody had interacted
    // with the page yet (autoplay rules). Played on the first tap or key.
    this.pendingSpeech = null;
    this.onSpeakingChange = null;
    this.onVoiceChange = null;

    // Microphone / listening state (see "Listening" below).
    this.recognitionRunning = false;   // between onstart and onend
    this.recognitionStarting = false;  // start() called, onstart not yet fired
    this.startRequestedAt = 0;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.watchdogTimer = null;
    this.pausing = false;              // storyteller tapped pause; flush on end
    this.ending = false;               // interview is closing; stay quiet
    this.blockedNotified = false;
    this.reacquiring = null;
    // 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'offline' |
    // 'no-microphone' | 'blocked' | 'paused' -- the page shows it in the hint.
    this.micState = 'idle';
    this.onMicStateChange = null;

    // The answer being spoken: finished phrases + the phrase still being heard.
    this.answerBuffer = '';
    this.interimText = '';
    this.answerTimer = null;
    this.draftEl = null;
    this.draftBubble = null;

    // Answers are sent one at a time, in order.
    this.responseChain = Promise.resolve();

    this.initSpeechRecognition();
    this.initSpeechSynthesis();
  }

  // ---- Spoken questions ----

  initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) {
      console.warn('Speech synthesis not supported in this browser -- questions will be text only');
      return;
    }
    // Voices load asynchronously; asking once makes them available sooner.
    window.speechSynthesis.getVoices();

    const playPending = () => {
      if (this.pendingSpeech) {
        const text = this.pendingSpeech;
        this.pendingSpeech = null;
        this.speakQuestion(text);
      }
    };
    document.addEventListener('pointerdown', playPending, true);
    document.addEventListener('keydown', playPending, true);
  }

  // A warm, natural-sounding English voice when the system has one.
  pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
    const preferences = [
      /natural/i,
      /enhanced|premium/i,
      /samantha/i,
      /google us english/i,
      /ava|allison|susan|karen|moira|serena|zoe/i,
    ];
    for (const pattern of preferences) {
      const match = english.find((v) => pattern.test(v.name));
      if (match) return match;
    }
    return english.find((v) => v.lang === 'en-US') || english[0] || null;
  }

  // The model writes markdown (**bold**, bullets); read the words, not the marks.
  // Split into sentences because Chrome stops long utterances after ~15s.
  speechChunks(text) {
    const plain = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .trim();
    return plain
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  speakQuestion(text) {
    if (this.ending || !this.voiceEnabled || !('speechSynthesis' in window)) return;
    const chunks = this.speechChunks(text);
    if (chunks.length === 0) return;

    this.cancelSpeech();
    this.setSpeaking(true);

    const voice = this.pickVoice();
    let remaining = chunks.length;
    this.activeUtterances = chunks.map((chunk) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = 'en-US';
      }
      utterance.rate = 0.95; // a little unhurried
      utterance.pitch = 1;

      utterance.onend = () => {
        remaining -= 1;
        if (remaining === 0) this.finishSpeaking();
      };
      utterance.onerror = (event) => {
        if (event.error === 'not-allowed') {
          // Autoplay rules: no interaction with this page yet. Keep the
          // question and play it on the first tap or key press.
          this.pendingSpeech = text;
          console.info('Question will be read aloud after the first tap (browser autoplay rules).');
        } else if (event.error !== 'canceled' && event.error !== 'interrupted') {
          console.warn('Could not read the question aloud:', event.error);
        }
        this.finishSpeaking();
      };
      return utterance;
    });

    // Chrome can be left paused (e.g. after a tab switch); resume before queueing.
    window.speechSynthesis.resume();
    this.activeUtterances.forEach((u) => window.speechSynthesis.speak(u));
  }

  // Silences whatever is playing without treating it as finished (so the
  // microphone isn't briefly switched back on between two questions).
  cancelSpeech() {
    if (!('speechSynthesis' in window)) return;
    // Detach handlers first so cancelling doesn't count as a finished question.
    this.activeUtterances.forEach((u) => {
      u.onend = null;
      u.onerror = null;
    });
    this.activeUtterances = [];
    window.speechSynthesis.cancel();
  }

  // Silences the question and goes back to listening.
  stopSpeaking() {
    this.cancelSpeech();
    if (this.isSpeaking) this.finishSpeaking();
  }

  finishSpeaking() {
    if (!this.isSpeaking) return;
    this.activeUtterances = [];
    this.setSpeaking(false);
    // Back to listening, if the storyteller had the microphone on.
    this.startListening();
  }

  setSpeaking(speaking) {
    this.isSpeaking = speaking;
    if (speaking && this.isRecording) {
      // Stop listening so the question isn't transcribed as an answer.
      this.stopListening({ immediate: true });
      this.interimText = '';
      this.renderDraft();
    }
    if (this.onSpeakingChange) this.onSpeakingChange(speaking);
  }

  // Header toggle. Remembered across interviews.
  setVoiceEnabled(enabled) {
    this.voiceEnabled = enabled;
    localStorage.setItem(VOICE_PREFERENCE_KEY, enabled ? 'on' : 'off');
    if (!enabled) {
      this.pendingSpeech = null;
      this.stopSpeaking();
    } else if (this.lastQuestion) {
      this.speakQuestion(this.lastQuestion);
    }
    return this.voiceEnabled;
  }

  // ---- Listening (speech recognition) ----
  //
  // What used to make the microphone feel unreliable, and what this does
  // instead:
  //  * Chrome ends recognition by itself after a silence, after about a
  //    minute, or on a network blip. It was restarted synchronously inside
  //    onend, which throws in Chrome and left the microphone dead. Now every
  //    (re)start goes through startListening(), with a short delay and
  //    backoff, and a watchdog restarts listening if it ever silently stops.
  //  * Every short "final" phrase was sent to the AI as a separate answer, so
  //    one spoken answer triggered several slow calls and the interviewer cut
  //    in mid-sentence. Now phrases are collected into one answer (shown live
  //    as a draft bubble) and sent once the storyteller pauses.
  //  * Errors (no speech, network, device unplugged, permission) were only
  //    logged. They are now handled and shown in the hint under the button.
  //  * The microphone was opened a second time just for a recorder whose
  //    audio was never used. It's now opened once, only to ask permission,
  //    and released straight away (speech recognition captures audio itself).

  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Speech recognition not supported in this browser');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    const browserLang = typeof navigator !== 'undefined' ? navigator.language : '';
    this.recognition.lang = browserLang && /^en/i.test(browserLang) ? browserLang : 'en-US';

    this.recognition.onstart = () => {
      this.recognitionStarting = false;
      this.recognitionRunning = true;
      this.restartAttempts = 0;
      this.setMicState('listening');
    };

    this.recognition.onresult = (event) => this.handleResult(event);

    this.recognition.onerror = (event) => this.handleRecognitionError(event.error);

    this.recognition.onend = () => {
      this.recognitionStarting = false;
      this.recognitionRunning = false;
      // Whatever was still being heard counts as said.
      if (this.interimText.trim() && !this.isSpeaking) {
        this.answerBuffer = this.joinPhrases(this.answerBuffer, this.interimText);
      }
      this.interimText = '';
      this.renderDraft();

      if (this.pausing) {
        // The storyteller paused: send what they said right away.
        this.pausing = false;
        this.flushAnswer();
        return;
      }
      if (this.shouldListen()) {
        this.scheduleRestart();
      } else if (this.answerBuffer.trim() && !this.isSpeaking) {
        this.scheduleAnswerFlush();
      }
    };

    // Coming back to the tab, or back online: pick listening straight back up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kickListening();
    });
    window.addEventListener('online', () => this.kickListening());
    window.addEventListener('offline', () => {
      if (this.isRecording) this.setMicState('offline');
    });
    // A headset plugged in or out: Chrome drops recognition on the old device.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (this.shouldListen()) {
          this.stopListening({ immediate: true });
          this.scheduleRestart(300);
        }
      });
    }
  }

  // Listening is wanted when the mic is on and the interviewer isn't talking.
  shouldListen() {
    return Boolean(this.recognition) && this.isRecording && !this.isSpeaking && !this.pausing && !this.ending;
  }

  startListening() {
    if (!this.shouldListen()) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.recognitionRunning || this.recognitionStarting) return;
    try {
      this.recognitionStarting = true;
      this.startRequestedAt = Date.now();
      this.recognition.start();
      if (this.micState !== 'reconnecting') this.setMicState('connecting');
    } catch (err) {
      // InvalidStateError: the previous session hasn't finished closing yet.
      this.recognitionStarting = false;
      this.scheduleRestart();
    }
  }

  scheduleRestart(delay) {
    if (!this.shouldListen() || this.restartTimer) return;
    const wait = delay ?? Math.min(RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts, RESTART_MAX_DELAY_MS);
    this.restartAttempts = Math.min(this.restartAttempts + 1, 10);
    if (this.restartAttempts > 2 && navigator.onLine !== false && this.micState === 'listening') {
      this.setMicState('reconnecting');
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startListening();
    }, wait);
  }

  // Restart now, forgetting any backoff (tab visible again, back online).
  kickListening() {
    if (!this.shouldListen()) return;
    this.restartAttempts = 0;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.startListening();
  }

  // immediate: drop audio in flight (abort) -- used while the interviewer
  // speaks, so its own voice is never transcribed. Otherwise stop(), which
  // lets Chrome deliver the words it already heard.
  stopListening({ immediate = false } = {}) {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.recognition || (!this.recognitionRunning && !this.recognitionStarting)) return false;
    try {
      if (immediate) this.recognition.abort();
      else this.recognition.stop();
    } catch (err) {
      return false;
    }
    return true;
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.shouldListen()) return;
      const stuck = this.recognitionStarting && Date.now() - this.startRequestedAt > START_STUCK_MS;
      if (stuck) {
        // start() never reported back -- reset and try again.
        this.recognitionStarting = false;
        try { this.recognition.abort(); } catch (err) { /* ignore */ }
      }
      if (stuck || (!this.recognitionRunning && !this.recognitionStarting && !this.restartTimer)) {
        this.scheduleRestart(0);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  stopWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  handleResult(event) {
    // Anything heard while a question is being read aloud is the
    // interviewer's own voice coming back through the microphone.
    if (this.isSpeaking || this.ending) return;

    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) {
        this.answerBuffer = this.joinPhrases(this.answerBuffer, transcript);
      } else {
        interim += transcript;
      }
    }
    this.interimText = interim;
    if (this.micState !== 'listening') this.setMicState('listening');

    // Live captions show everything heard so far, including the phrase in progress.
    if (this.captionsEnabled) {
      this.showLiveCaptions(this.joinPhrases(this.answerBuffer, this.interimText));
    }
    this.renderDraft();

    // Still talking -> wait; the answer is sent after a pause.
    this.scheduleAnswerFlush();
  }

  handleRecognitionError(error) {
    switch (error) {
      case 'no-speech':
      case 'aborted':
        // Normal: silence, or we stopped it ourselves. onend restarts.
        return;
      case 'network':
        this.setMicState(navigator.onLine === false ? 'offline' : 'reconnecting');
        return;
      case 'audio-capture':
        // No microphone, or it was unplugged / taken by another app.
        this.setMicState('no-microphone');
        this.restartAttempts = Math.max(this.restartAttempts, 4);
        return;
      case 'not-allowed':
      case 'service-not-allowed':
        this.isRecording = false;
        this.stopWatchdog();
        this.setMicState('blocked');
        if (!this.blockedNotified) {
          this.blockedNotified = true;
          alert('Microphone access is blocked. Allow the microphone for this site (the icon in the address bar), then tap the microphone button again.');
        }
        return;
      default:
        console.warn('Speech recognition error:', error);
    }
  }

  joinPhrases(a, b) {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    if (!left) return right;
    if (!right) return left;
    return `${left} ${right}`;
  }

  // Sends the collected answer once the storyteller has been quiet for a moment.
  scheduleAnswerFlush() {
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
    if (!this.answerBuffer.trim() && !this.interimText.trim()) return;
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.interimText.trim() && this.recognitionRunning) {
        // Words still arriving -- wait for them to settle.
        this.scheduleAnswerFlush();
        return;
      }
      this.flushAnswer();
    }, ANSWER_PAUSE_MS);
  }

  flushAnswer() {
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
    const answer = this.joinPhrases(this.answerBuffer, this.interimText);
    this.answerBuffer = '';
    this.interimText = '';
    this.clearDraft();
    if (this.captionsEnabled) this.showLiveCaptions('');
    if (!answer || this.ending) return;
    this.currentTranscript = this.joinPhrases(this.currentTranscript, answer);
    this.addUserMessage(answer);
    this.sendResponse(answer).catch(() => {
      // Already shown in the chat by sendResponse().
    });
  }

  // The words being spoken right now, shown as a faint answer bubble, so the
  // storyteller can see the microphone is hearing them.
  renderDraft() {
    const text = this.joinPhrases(this.answerBuffer, this.interimText);
    if (!text) {
      this.clearDraft();
      return;
    }
    const chatContainer = document.querySelector('.chat-container');
    if (!chatContainer) return;
    if (!this.draftEl) {
      this.draftEl = document.createElement('div');
      this.draftEl.className = 'message answer draft';
      this.draftEl.setAttribute('aria-live', 'polite');
      this.draftBubble = document.createElement('div');
      this.draftBubble.className = 'message-bubble';
      this.draftEl.appendChild(this.draftBubble);
    }
    // Always the last message, even if a question or indicator was added since.
    if (chatContainer.lastElementChild !== this.draftEl) {
      chatContainer.appendChild(this.draftEl);
    }
    this.draftBubble.textContent = text;
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  clearDraft() {
    if (this.draftEl) this.draftEl.remove();
    this.draftEl = null;
    this.draftBubble = null;
  }

  setMicState(state) {
    if (this.micState === state) return;
    this.micState = state;
    if (this.onMicStateChange) this.onMicStateChange(state);
  }

  // Asks for microphone permission (once), with a friendly message for each
  // way it can fail. The stream is released right away: speech recognition
  // opens the microphone itself, and holding a second capture open made
  // recognition flaky on some devices.
  async requestMicrophonePermission() {
    if (this.microphoneReady) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Very old browser: let speech recognition ask by itself.
      this.microphoneReady = true;
      return true;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getTracks().forEach((track) => track.stop());
      this.microphoneReady = true;
      console.log('✅ Microphone permission granted');
      return true;
    } catch (error) {
      console.error('Microphone unavailable:', error);
      const name = error && error.name;
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.setMicState('no-microphone');
        alert('No microphone was found. Plug one in (or choose one in your sound settings), then tap the microphone button again.');
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        this.setMicState('no-microphone');
        alert('The microphone is busy in another app. Close that app, then tap the microphone button again.');
      } else {
        this.setMicState('blocked');
        alert('Microphone access is blocked. Allow the microphone for this site (the icon in the address bar), then tap the microphone button again.');
      }
      return false;
    }
  }

  // Toggle captions
  toggleCaptions() {
    this.captionsEnabled = !this.captionsEnabled;
    const captionsOverlay = document.getElementById('captionsOverlay');

    if (this.captionsEnabled) {
      if (!captionsOverlay) {
        this.createCaptionsOverlay();
      }
      captionsOverlay.style.display = 'block';
    } else {
      if (captionsOverlay) {
        captionsOverlay.style.display = 'none';
      }
    }

    return this.captionsEnabled;
  }

  // Create captions overlay
  createCaptionsOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'captionsOverlay';
    overlay.style.cssText = `
      position: fixed;
      bottom: 200px;
      left: 1rem;
      right: 1rem;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 1rem;
      border-radius: 8px;
      font-size: 1.1rem;
      line-height: 1.6;
      text-align: center;
      z-index: 100;
      min-height: 60px;
      display: none;
    `;
    document.body.appendChild(overlay);
  }

  // Show live captions
  showLiveCaptions(text) {
    const captionsOverlay = document.getElementById('captionsOverlay');
    if (captionsOverlay && this.captionsEnabled) {
      captionsOverlay.textContent = text;
    }
  }

  // Start interview session
  async startInterview(mode) {
    try {
      const response = await fetch(`${INTERVIEW_API_BASE_URL}/interview/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: mode || 'Life Period',
          userId: 'user_' + Date.now(), // In production, use real user ID
        }),
      });

      const data = await response.json();

      if (data.success) {
        this.sessionId = data.sessionId;
        this.addAssistantMessage(data.question);
        console.log('✅ Interview started:', this.sessionId);
        return data.question;
      } else {
        throw new Error(data.error || 'Failed to start interview');
      }
    } catch (error) {
      console.error('Error starting interview:', error);
      this.showError('Failed to start interview. Please check if the server is running.');
      throw error;
    }
  }

  // Resume a recorded interview. `history` is the saved exchange, oldest first,
  // as [{ role: 'assistant' | 'user', content }]. It's redrawn in the chat and
  // handed to the server, which seeds a new session with it and asks the next
  // question. Drawn without addUserMessage()/onTurn on purpose: these turns are
  // already saved, and replaying them through the hook would store them twice.
  async resumeInterview(mode, history) {
    try {
      const response = await fetch(`${INTERVIEW_API_BASE_URL}/interview/resume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: mode || 'Life Period',
          history,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to resume interview');
      }

      for (const entry of history) {
        this.renderMessage(entry.role === 'assistant' ? 'question' : 'answer', entry.content);
        this.conversationHistory.push({ role: entry.role, content: entry.content });
        if (entry.role === 'assistant') this.lastQuestion = entry.content;
      }

      this.sessionId = data.sessionId;
      this.addAssistantMessage(data.question);
      console.log('✅ Interview resumed:', this.sessionId);
      return data.question;
    } catch (error) {
      console.error('Error resuming interview:', error);
      this.showError('Failed to resume interview. Please check if the server is running.');
      throw error;
    }
  }

  // Send user response and get next question. Answers are queued so they reach
  // the server one at a time and in order (an answer given while the previous
  // one is still being answered waits its turn instead of racing it).
  sendResponse(response) {
    if (!this.sessionId) {
      console.error('No active session');
      return Promise.resolve();
    }

    // The storyteller has answered (typed, skipped, or spoke over it) -- no
    // need to finish reading the question out.
    this.pendingSpeech = null;
    if (this.isSpeaking) this.stopSpeaking();

    const run = () => this.postResponse(response);
    const result = this.responseChain.then(run, run);
    this.responseChain = result.catch(() => {});
    return result;
  }

  async postResponse(response) {
    if (this.ending) return undefined;
    this.showTypingIndicator();
    try {
      const data = await this.postJson('/interview/respond', {
        sessionId: this.sessionId,
        response,
      }, { retries: 1 });
      this.hideTypingIndicator();
      if (!data.success) throw new Error(data.error || 'Failed to get response');
      if (!this.ending) this.addAssistantMessage(data.question);
      return data.question;
    } catch (error) {
      console.error('Error sending response:', error);
      this.hideTypingIndicator();
      if (!this.ending) {
        this.showError(error.name === 'AbortError'
          ? 'The interviewer is taking too long to reply. Please say or type your answer again.'
          : 'Failed to get next question. Please try again.');
      }
      throw error;
    }
  }

  // POST JSON with a time limit, so a stalled request can never hang the chat.
  // `retries` repeats it after a network failure (not after a server error, so
  // an answer is never stored twice once the server has accepted it).
  async postJson(path, body, { retries = 0, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetch(`${INTERVIEW_API_BASE_URL}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
        return await res.json();
      } catch (error) {
        const networkFailure = error && error.name === 'TypeError';
        if (!networkFailure || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 800));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  // End interview
  async endInterview() {
    if (!this.sessionId) {
      console.error('No active session');
      return;
    }

    try {
      const response = await fetch(`${INTERVIEW_API_BASE_URL}/interview/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
        }),
      });

      const data = await response.json();

      if (data.success) {
        console.log('✅ Interview ended');
        console.log('Story:', data.story);
        return data;
      } else {
        throw new Error(data.error || 'Failed to end interview');
      }
    } catch (error) {
      console.error('Error ending interview:', error);
      this.showError('Failed to end interview properly.');
      throw error;
    }
  }

  // Start/stop recording (the microphone button). Returns whether the
  // microphone is now on.
  async toggleRecording() {
    if (!this.recognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome, Edge or Safari -- or choose "Type" to answer by keyboard.');
      return false;
    }

    if (this.isRecording) {
      // Pause: stop listening, but keep (and send) what was already said.
      this.isRecording = false;
      this.stopWatchdog();
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
      // stop() lets Chrome hand over the last words; onend then sends them.
      this.pausing = this.stopListening();
      if (!this.pausing) this.flushAnswer();
      this.setMicState('paused');
      return false;
    }

    // Asked once; afterwards starting again is instant.
    const granted = await this.requestMicrophonePermission();
    if (!granted) return false;

    this.isRecording = true;
    this.pausing = false;
    this.restartAttempts = 0;
    this.startWatchdog();
    // Starts right away -- or, if a question is being read aloud, as soon as
    // it finishes (finishSpeaking()).
    if (this.isSpeaking) this.setMicState('connecting');
    else this.startListening();
    return true;
  }

  // Stop all recording and clean up
  cleanup() {
    // Set first so nothing restarts listening while shutting down.
    this.ending = true;
    this.isRecording = false;
    this.pausing = false;
    this.pendingSpeech = null;
    this.stopWatchdog();
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.stopSpeaking();
    this.stopListening({ immediate: true });
    this.clearDraft();
    this.setMicState('idle');
  }

  // Whatever the storyteller said but hasn't been sent yet (e.g. they tapped
  // End mid-sentence). Called by the page before ending the interview.
  takeUnsentAnswer() {
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
    const answer = this.joinPhrases(this.answerBuffer, this.interimText);
    this.answerBuffer = '';
    this.interimText = '';
    this.clearDraft();
    return answer;
  }

  // Draw one chat bubble. `kind` is 'question' (the interviewer) or 'answer'.
  renderMessage(kind, text) {
    const chatContainer = document.querySelector('.chat-container');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${kind}`;
    messageDiv.innerHTML = `
      <div class="message-bubble">${this.escapeHtml(text)}</div>
    `;
    // Every question can be heard again -- also the way to play one the
    // browser wouldn't read aloud before the first tap.
    if (kind === 'question' && 'speechSynthesis' in window) {
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'speak-button';
      replay.textContent = '🔊 Listen';
      replay.setAttribute('aria-label', 'Read this question aloud');
      replay.addEventListener('click', () => {
        this.pendingSpeech = null;
        if (!this.voiceEnabled) {
          // Turn voice back on without also replaying the latest question.
          this.voiceEnabled = true;
          localStorage.setItem(VOICE_PREFERENCE_KEY, 'on');
          if (this.onVoiceChange) this.onVoiceChange(true);
        }
        this.speakQuestion(text);
      });
      messageDiv.appendChild(replay);
    }
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Add user message to chat
  addUserMessage(text) {
    this.renderMessage('answer', text);

    this.conversationHistory.push({
      role: 'user',
      content: text,
    });

    // Fires for every answer the storyteller gives -- spoken or typed. The
    // question is the one that prompted it, read before the follow-up question
    // arrives, so the pair stays in step.
    if (this.onTurn) this.onTurn({ question: this.lastQuestion, answer: text });
  }

  // Add assistant message to chat
  addAssistantMessage(text) {
    this.renderMessage('question', text);

    this.conversationHistory.push({
      role: 'assistant',
      content: text,
    });

    // Remembered so the answer that follows can be saved together with the
    // question it was answering.
    this.lastQuestion = text;

    // Every new question from the interviewer is also read aloud -- in
    // addition to the text bubble above, never instead of it. The bubble is
    // drawn first and stays in the chat whether the voice plays, is muted,
    // blocked by the browser, or interrupted. (Questions redrawn from a
    // resumed interview go through renderMessage() directly, so only the new
    // one is spoken.)
    this.speakQuestion(text);
  }

  // Show typing indicator
  showTypingIndicator() {
    // One at a time: queued answers must not stack several "…" bubbles.
    if (document.getElementById('typingIndicator')) return;
    const chatContainer = document.querySelector('.chat-container');
    const indicator = document.createElement('div');
    indicator.className = 'message question typing-indicator';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `
      <div class="message-bubble">
        <div class="loading-indicator">
          <span class="loading-dots">
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
          </span>
        </div>
      </div>
    `;
    chatContainer.appendChild(indicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Hide typing indicator
  hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
      indicator.remove();
    }
  }

  // Show error message
  showError(message) {
    const chatContainer = document.querySelector('.chat-container');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'message error';
    errorDiv.innerHTML = `
      <div class="message-bubble" style="background: #fee; color: #c00; border: 1px solid #fcc;">
        ⚠️ ${this.escapeHtml(message)}
      </div>
    `;
    chatContainer.appendChild(errorDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export for use in interview page
window.InterviewClient = InterviewClient;
