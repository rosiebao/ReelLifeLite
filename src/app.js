const express = require('express');
const fs = require('fs');
const path = require('path');

// Local settings for `npm start` -- turning on the AI interviewer, AWS keys,
// PORT -- live in frontend/.env (copy .env.example). It's git-ignored, so keys
// stay on your machine, and anything already set in the shell wins over it.
// Loaded before the routers below because interviewer.js reads its settings
// as it loads. Skipped when the tests require this file, so they never pick
// up someone's real AWS setup.
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
const { router: storiesRouter } = require('./stories');
const { ApiError } = require('./errors');

const app = express();
const PORT = process.env.PORT || 6767;

app.use(express.json());

// Accounts + conversation history API (re-implemented from ../database, the
// Python/FastAPI version, which is kept around unused for reference).
app.use(authRouter);
app.use(conversationsRouter);
app.use(draftsRouter);
app.use(familyRouter);
app.use(friendsRouter);
app.use(interviewRouter);
app.use(storiesRouter);

// Serve static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
        console.log(require('./interviewer').describe());
    });
}

module.exports = app;
