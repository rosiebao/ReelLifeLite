const express = require('express');
const path = require('path');
const { router: authRouter } = require('./auth');
const { router: conversationsRouter } = require('./conversations');
const { router: familyRouter } = require('./family');
const { router: friendsRouter } = require('./friends');
const { router: storiesRouter } = require('./stories');
const { ApiError } = require('./errors');

const app = express();
const PORT = process.env.PORT || 6767;

app.use(express.json());

// Accounts + conversation history API (re-implemented from ../database, the
// Python/FastAPI version, which is kept around unused for reference).
app.use(authRouter);
app.use(conversationsRouter);
app.use(familyRouter);
app.use(friendsRouter);
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
    });
}

module.exports = app;
