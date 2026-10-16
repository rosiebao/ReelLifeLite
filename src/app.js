const express = require('express');
const fs = require('fs');
const path = require('path');

// this file is the first to be run (see package.json) so basically all the configuration is here
// select AI model (.env file)
// select the port (just read it literally says PORT = process.env.PORT || ####)

const ENV_FILE = path.join(__dirname, '.env');
if (require.main === module && fs.existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
}

const { router: authRouter } = require('./auth');
const { router: conversationsRouter } = require('./conversations');
const { router: draftsRouter } = require('./drafts');
const { router: familyRouter } = require('./family');
const { router: friendsRouter } = require('./friends');
const { router: interviewRouter } = require('./interview');
const { router: profileRouter } = require('./profile');
const { router: storiesRouter } = require('./stories');
const { router: storyPhotosRouter } = require('./storyPhotos');
const { ApiError } = require('./errors');

const app = express();
const PORT = process.env.PORT || 6767;

// A photo (up to 5 MB) arrives base64-encoded in JSON, which makes it about a
// third bigger; everything else keeps express's 100 KB default. That's the
// profile photo and the photos published with a story.
app.use('/profile/photo', express.json({ limit: '8mb' }));
app.use('/stories/photos', express.json({ limit: '8mb' }));
app.use(express.json());
app.use(authRouter);
app.use(conversationsRouter);
app.use(draftsRouter);
app.use(familyRouter);
app.use(friendsRouter);
app.use(interviewRouter);
app.use(profileRouter);
// Before storiesRouter, whose /stories/:id would otherwise see "photos".
app.use(storyPhotosRouter);
app.use(storiesRouter);
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    // body-parser's own errors (too large, malformed JSON) carry a 4xx status.
    if (err?.type === 'entity.too.large') {
        res.status(413).json({ error: 'That upload is too large' });
        return;
    }
    if (err?.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Request body is not valid JSON' });
        return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
        const interviewer = require('./interviewer');
        console.log(interviewer.describe());
        // Try Claude once, so a wrong key or region shows up in the deploy log.
        interviewer.checkConnection().then((result) => {
            if (result.ok) console.log('Interview AI: connection to Claude OK');
            else if (result.problem !== 'off') console.error(`Interview AI: NOT WORKING -- ${result.problem}`);
        });
    });
}

module.exports = app;
