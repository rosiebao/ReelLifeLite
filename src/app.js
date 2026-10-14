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
const { router: storiesRouter } = require('./stories');
const { ApiError } = require('./errors');

const app = express();
const PORT = process.env.PORT || 6767;

app.use(express.json());
app.use(authRouter);
app.use(conversationsRouter);
app.use(draftsRouter);
app.use(familyRouter);
app.use(friendsRouter);
app.use(interviewRouter);
app.use(storiesRouter);
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
