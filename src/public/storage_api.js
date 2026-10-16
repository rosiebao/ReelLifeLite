// Thin client for the accounts/conversations API served by this same Express
// app (../auth.js, ../conversations.js, ../family.js). Every fetch() call
// against that API should go through here so token storage and error handling
// stay in one place.

const AUTH_TOKEN_KEY = "reellife_token";

const tokenStore = {
  get: () => localStorage.getItem(AUTH_TOKEN_KEY),
  set(token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  },
};

class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

// HTTP/2 and HTTP/3 -- which is what Render (and most hosts) serve over --
// carry no reason phrase, so statusText is "" there even though it reads
// "Unauthorized" on localhost. Without this, a non-JSON error shows the user an
// empty message and the button looks like it did nothing.
function fallbackDetail(response) {
  return response.statusText || `Request failed (${response.status})`;
}

async function parseErrorDetail(response) {
  try {
    const body = await response.json();
    // Express sends {error}; the old Python/FastAPI backend sent {detail}.
    // Accept either, so the real reason reaches the user instead of a bare
    // "Bad Request" from response.statusText.
    return body.error ?? body.detail ?? fallbackDetail(response);
  } catch {
    return fallbackDetail(response);
  }
}

// Core fetch wrapper. Adds the bearer token (if present) and normalizes
// errors into ApiError. There's no refresh token in this API -- a 401 just
// means the session is gone, so callers should clear it and send the user
// back to login.html.
async function apiFetch(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = tokenStore.get();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 && auth) tokenStore.clear();
    throw new ApiError(response.status, await parseErrorDetail(response));
  }

  // 204 is "nothing here" rather than an error -- GET /conversations/{id}/story
  // uses it for a conversation nobody has published yet.
  if (response.status === 204) return null;

  return response.json();
}

const storageApi = {
  // ---- Auth ----

  signup({ username, email, password }) {
    return apiFetch("/signup", { method: "POST", auth: false, body: { username, email, password } });
  },

  async login({ email, password }) {
    const data = await apiFetch("/login", { method: "POST", auth: false, body: { email, password } });
    tokenStore.set(data.token);
    return data;
  },

  async logout() {
    try {
      await apiFetch("/logout", { method: "POST" });
    } catch {
      // Best-effort; clear the local token either way.
    } finally {
      tokenStore.clear();
    }
  },

  whoami() {
    return apiFetch("/whoami");
  },

  // ---- Profile ----

  getProfile() {
    return apiFetch("/profile");
  },

  // Only the fields passed are changed.
  updateProfile(changes) {
    return apiFetch("/profile", { method: "PUT", body: changes });
  },

  uploadProfilePhoto({ filename, dataBase64 }) {
    return apiFetch("/profile/photo", { method: "PUT", body: { filename, data_base64: dataBase64 } });
  },

  isLoggedIn() {
    return Boolean(tokenStore.get());
  },

  // ---- Conversations ----

  createConversation() {
    return apiFetch("/conversations", { method: "POST" });
  },

  listConversations() {
    return apiFetch("/conversations");
  },

  getConversation(conversationId) {
    return apiFetch(`/conversations/${conversationId}`);
  },

  // For good: its answers, drafts and transcript. A story published from it
  // stays up (delete that separately, from Your Stories).
  deleteConversation(conversationId) {
    return apiFetch(`/conversations/${conversationId}`, { method: "DELETE" });
  },

  getPrompts(conversationId) {
    return apiFetch(`/conversations/${conversationId}/prompts`);
  },

  addPrompt(conversationId, { content, inputMediaFilename, inputMediaBase64 } = {}) {
    return apiFetch(`/conversations/${conversationId}/prompts`, {
      method: "POST",
      body: {
        content,
        input_media_filename: inputMediaFilename || null,
        input_media_base64: inputMediaBase64 || null,
      },
    });
  },

  addResponse(promptId, { response, outputMediaFilename, outputMediaBase64, cost } = {}) {
    return apiFetch(`/prompts/${promptId}/response`, {
      method: "POST",
      body: {
        response,
        output_media_filename: outputMediaFilename || null,
        output_media_base64: outputMediaBase64 || null,
        cost: cost ?? 0,
      },
    });
  },

  // ---- Interview (Story tab) ----
  // An interview is a conversation whose replies come from the interviewer
  // (see ../interview.js). Each call returns the interviewer's `question`.

  startInterview(conversationId, mode) {
    return apiFetch(`/conversations/${conversationId}/interview/start`, { method: "POST", body: { mode } });
  },

  answerInterview(conversationId, content) {
    return apiFetch(`/conversations/${conversationId}/interview/answer`, { method: "POST", body: { content } });
  },

  skipInterviewQuestion(conversationId) {
    return apiFetch(`/conversations/${conversationId}/interview/skip`, { method: "POST" });
  },

  // { story, title, summary, place, time_period, tags, draft_id, created_at }
  // -- the interview written up as a story, with the publish form's details
  // drafted too. `answer` is
  // a last answer to save into the interview first (ending mid-answer).
  draftInterviewStory(conversationId, { answer } = {}) {
    return apiFetch(`/conversations/${conversationId}/interview/story`, {
      method: "POST",
      body: answer ? { answer } : {},
    });
  },

  // ---- Family tree ----
  // Both return the caller's own tree:
  // { rows: [ { members: [ { member_id, name, photo_url, relationship, status, ... } ] } ], seeded }.

  getFamily() {
    return apiFetch("/family");
  },

  saveFamily(tree) {
    return apiFetch("/family", { method: "PUT", body: tree });
  },

  // -> { token, member }. `changes` may carry the { email } it's being sent to.
  inviteFamilyMember(memberId, changes = {}) {
    return apiFetch(`/family/members/${memberId}/invite`, { method: "POST", body: changes });
  },

  getFamilyInvite(token) {
    return apiFetch(`/family/invites/${encodeURIComponent(token)}`);
  },

  acceptFamilyInvite(token) {
    return apiFetch(`/family/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
  },

  // ---- Family requests (Search member) ----
  // [{ id, username, photo_url, family_status: "none" | "requested" | "in_tree" }]
  searchFamilyMembers(query) {
    return apiFetch(`/family/search?q=${encodeURIComponent(query)}`);
  },

  // Asks `username` to take tree member `memberId`'s place -> { member }.
  sendFamilyRequest(memberId, username) {
    return apiFetch(`/family/members/${memberId}/request`, { method: "POST", body: { username } });
  },

  cancelFamilyRequest(memberId) {
    return apiFetch(`/family/members/${memberId}/request`, { method: "DELETE" });
  },

  // The requests waiting on you: [{ request_id, requested_at, from, member }].
  listFamilyRequests() {
    return apiFetch("/family/requests");
  },

  acceptFamilyRequest(requestId) {
    return apiFetch(`/family/requests/${requestId}/accept`, { method: "POST" });
  },

  declineFamilyRequest(requestId) {
    return apiFetch(`/family/requests/${requestId}/decline`, { method: "POST" });
  },

  // ---- Stories ----
  // publishStory both creates and updates: publishing a conversation that's
  // already been published edits its existing story (see ../stories.js).

  // `visibility`: "private", or the audiences to share with as a list --
  // ["friends"], ["friends", "family"], ["public"] (see ../stories.js).
  // `photoIds`: the story's photos in order (from uploadStoryPhoto), the first
  // being the cover; left out, a story already published keeps its photos.
  publishStory({ conversationId, title, summary, content, tags, place, timePeriod, photo, visibility, photoIds } = {}) {
    return apiFetch("/stories", {
      method: "POST",
      body: {
        conversation_id: conversationId ?? null,
        title,
        summary: summary ?? "",
        content: content ?? "",
        tags: tags ?? [],
        place: place ?? "",
        time_period: timePeriod ?? "",
        photo: photo ?? "",
        visibility: visibility ?? "private",
        ...(photoIds ? { photo_ids: photoIds } : {}),
      },
    });
  },

  // One picture for a story, uploaded as soon as it's picked -> { photo_id,
  // url }. It's only published once the story is saved with its photo_id.
  uploadStoryPhoto({ filename, dataBase64 }) {
    return apiFetch("/stories/photos", { method: "POST", body: { filename, data_base64: dataBase64 } });
  },

  // Feed cards carry no `content`; getStory() fetches the full text.
  listMyStories() {
    return apiFetch("/stories/mine");
  },

  listFriendStories() {
    return apiFetch("/stories/friends");
  },

  // What one person has shared with you, newest first (the Family page).
  listUserStories(userId) {
    return apiFetch(`/users/${userId}/stories`);
  },

  listCommunityStories() {
    return apiFetch("/stories/community");
  },

  getStory(storyId) {
    return apiFetch(`/stories/${storyId}`);
  },

  // null when this conversation hasn't been published.
  getConversationStory(conversationId) {
    return apiFetch(`/conversations/${conversationId}/story`);
  },

  updateStory(storyId, changes) {
    return apiFetch(`/stories/${storyId}`, { method: "PATCH", body: changes });
  },

  deleteStory(storyId) {
    return apiFetch(`/stories/${storyId}`, { method: "DELETE" });
  },

  // ---- Friends ----

  listFriends() {
    return apiFetch("/friends");
  },

  listFriendRequests() {
    return apiFetch("/friends/requests");
  },

  searchUsers(query) {
    return apiFetch(`/users/search?q=${encodeURIComponent(query)}`);
  },

  sendFriendRequest(username) {
    return apiFetch("/friends/requests", { method: "POST", body: { username } });
  },

  acceptFriendRequest(friendshipId) {
    return apiFetch(`/friends/requests/${friendshipId}/accept`, { method: "POST" });
  },

  declineFriendRequest(friendshipId) {
    return apiFetch(`/friends/requests/${friendshipId}/decline`, { method: "POST" });
  },

  // Also how a sender cancels a request they sent: either end removes the link.
  removeFriend(userId) {
    return apiFetch(`/friends/${userId}`, { method: "DELETE" });
  },
};
