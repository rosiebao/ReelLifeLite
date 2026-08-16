// ReelLife Interview Client
// Connects to backend API with AWS Bedrock (Anthropic Claude)

const API_BASE_URL = 'http://localhost:3000/api';

class InterviewClient {
  constructor() {
    this.sessionId = null;
    this.isRecording = false;
    this.conversationHistory = [];
    this.recognition = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.microphoneStream = null;
    this.currentTranscript = '';
    this.captionsEnabled = false;
    this.initSpeechRecognition();
  }

  // Initialize speech recognition (Web Speech API)
  initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      console.warn('Speech recognition not supported in this browser');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript += transcript;
        }
      }

      // Show live captions if enabled
      if (this.captionsEnabled && interimTranscript) {
        this.showLiveCaptions(interimTranscript);
      }

      // Update UI with transcript
      if (finalTranscript) {
        this.currentTranscript += finalTranscript;
        this.addUserMessage(finalTranscript.trim());
        this.sendResponse(finalTranscript.trim());
      }
    };

    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        alert('Microphone access was denied. Please allow microphone access to continue.');
      }
    };

    this.recognition.onend = () => {
      // Restart if still recording
      if (this.isRecording) {
        this.recognition.start();
      }
    };
  }

  // Request microphone permission and start audio recording
  async requestMicrophonePermission() {
    try {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Initialize MediaRecorder for actual audio recording
      this.mediaRecorder = new MediaRecorder(this.microphoneStream);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.audioChunks = [];
        // Store audio blob if needed for future playback
        console.log('Audio recording saved:', audioBlob.size, 'bytes');
      };

      console.log('✅ Microphone permission granted');
      return true;
    } catch (error) {
      console.error('Microphone permission denied:', error);
      alert('Unable to access microphone. Please check your browser permissions.');
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
      const response = await fetch(`${API_BASE_URL}/interview/start`, {
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

  // Send user response and get next question
  async sendResponse(response) {
    if (!this.sessionId) {
      console.error('No active session');
      return;
    }

    try {
      // Show loading indicator
      this.showTypingIndicator();

      const apiResponse = await fetch(`${API_BASE_URL}/interview/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          response: response,
        }),
      });

      const data = await apiResponse.json();

      // Hide loading indicator
      this.hideTypingIndicator();

      if (data.success) {
        this.addAssistantMessage(data.question);
        return data.question;
      } else {
        throw new Error(data.error || 'Failed to get response');
      }
    } catch (error) {
      console.error('Error sending response:', error);
      this.hideTypingIndicator();
      this.showError('Failed to get next question. Please try again.');
      throw error;
    }
  }

  // End interview
  async endInterview() {
    if (!this.sessionId) {
      console.error('No active session');
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/interview/end`, {
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

  // Start/stop recording
  async toggleRecording() {
    if (!this.recognition) {
      alert('Speech recognition is not supported in your browser. Please use Chrome or Edge.');
      return false;
    }

    if (this.isRecording) {
      // Stop recording
      this.recognition.stop();
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
      }
      this.isRecording = false;
    } else {
      // Request permission first time
      if (!this.microphoneStream) {
        const granted = await this.requestMicrophonePermission();
        if (!granted) {
          return false;
        }
      }

      // Start recording
      this.currentTranscript = '';
      this.recognition.start();
      if (this.mediaRecorder && this.mediaRecorder.state !== 'recording') {
        this.mediaRecorder.start();
      }
      this.isRecording = true;
    }

    return this.isRecording;
  }

  // Stop all recording and clean up
  cleanup() {
    if (this.recognition) {
      this.recognition.stop();
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach(track => track.stop());
    }
  }

  // Add user message to chat
  addUserMessage(text) {
    const chatContainer = document.querySelector('.chat-container');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message answer';
    messageDiv.innerHTML = `
      <div class="message-bubble">${this.escapeHtml(text)}</div>
    `;
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    this.conversationHistory.push({
      role: 'user',
      content: text,
    });
  }

  // Add assistant message to chat
  addAssistantMessage(text) {
    const chatContainer = document.querySelector('.chat-container');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message question';
    messageDiv.innerHTML = `
      <div class="message-bubble">${this.escapeHtml(text)}</div>
    `;
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    this.conversationHistory.push({
      role: 'assistant',
      content: text,
    });
  }

  // Show typing indicator
  showTypingIndicator() {
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
