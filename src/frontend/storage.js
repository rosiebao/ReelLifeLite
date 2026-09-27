// Conversation transcript + media attachment storage on disk. Mirrors
// ../database/app/storage.py: large content (the running transcript,
// attached media) is written to files under MEDIA_ROOT, with only the
// resulting path stored in the database.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

let mediaRoot = process.env.MEDIA_ROOT || path.join(__dirname, "conversation_files");

function setMediaRoot(dir) {
    mediaRoot = dir;
}

function conversationDir(conversationId) {
    const dir = path.join(mediaRoot, String(conversationId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function transcriptPath(conversationId) {
    return path.join(conversationDir(conversationId), "transcript.txt");
}

function appendTranscript(conversationId, line) {
    fs.appendFileSync(transcriptPath(conversationId), line + "\n", "utf8");
}

// Only the base filename (never any directory components) is used, so a
// caller-supplied name like "../../evil.txt" can't write outside mediaRoot.
function saveMedia(conversationId, filename, base64Data) {
    const safeName = `${crypto.randomBytes(4).toString("hex")}_${path.basename(filename)}`;
    const dir = path.join(conversationDir(conversationId), "media");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    return filePath;
}

module.exports = { conversationDir, transcriptPath, appendTranscript, saveMedia, setMediaRoot };
