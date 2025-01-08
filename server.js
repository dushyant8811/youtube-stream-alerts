const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
const PORT = 8080;

// WebSocket server for frontend communication
const wss = new WebSocket.Server({ noServer: true });

// Your OAuth2 client credentials
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);

const SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
];

// Middleware for parsing JSON
app.use(bodyParser.json());

// WebSocket connection setup
wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
});

// Send message to all connected WebSocket clients
function sendMessageToClients(message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Route to initiate OAuth flow
app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
    res.redirect(authUrl);
});

// Route to handle OAuth callback
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        res.send('Authentication successful! You can close this tab.');
        console.log('Tokens:', tokens);
        startBroadcastPolling(); // Start polling for active broadcasts
    } catch (error) {
        console.error('Error retrieving tokens:', error);
        res.status(500).send('Authentication failed');
    }
});

// Set to track displayed message IDs
const displayedMessageIds = new Set();
let nextPageToken = null; // Store the nextPageToken for efficient polling

// Continuous polling for active broadcasts
let currentLiveChatId = null;

function startBroadcastPolling() {
    setInterval(async () => {
        try {
            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
            const response = await youtube.liveBroadcasts.list({
                part: 'snippet',
                broadcastStatus: 'active',
                broadcastType: 'all',
            });

            if (response.data.items && response.data.items.length > 0) {
                const liveChatId = response.data.items[0].snippet.liveChatId;

                if (currentLiveChatId !== liveChatId) {
                    console.log('New active broadcast found:', liveChatId);
                    currentLiveChatId = liveChatId;
                    displayedMessageIds.clear(); // Clear the message ID set for the new stream
                    nextPageToken = null; // Reset nextPageToken for the new stream
                    fetchChatMessages(liveChatId);
                } else {
                    console.log('Broadcast already being tracked.');
                }
            } else {
                console.log('No active broadcasts found.');
                currentLiveChatId = null;
            }
        } catch (error) {
            console.error('Error polling for active broadcasts:', error);
        }
    }, 60000); // Poll every 60 seconds
}

// Fetch chat messages and filter for Superchat or Member events
async function fetchChatMessages(liveChatId) {
    try {
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        // Polling for new messages every 30 seconds
        setInterval(async () => {
            if (!liveChatId) return; // Skip if no liveChatId is available

            try {
                const params = {
                    liveChatId,
                    part: 'snippet,authorDetails',
                };
                if (nextPageToken) {
                    params.pageToken = nextPageToken; // Use nextPageToken if available
                }

                const response = await youtube.liveChatMessages.list(params);
                nextPageToken = response.data.nextPageToken; // Update nextPageToken

                response.data.items.forEach((message) => {
                    const messageId = message.id;

                    // Skip if the message ID has already been displayed
                    if (displayedMessageIds.has(messageId)) return;

                    // Add the new message ID to the set
                    displayedMessageIds.add(messageId);

                    if (message.snippet.superChatDetails) {
                        // SuperChat detected
                        const superChatDetails = message.snippet.superChatDetails;
                        sendMessageToClients({
                            type: 'SUPERCHAT',
                            sender: message.authorDetails.displayName,
                            amount: superChatDetails.amountDisplayString,
                            message: superChatDetails.userComment || "",
                        });
                    } else if (message.snippet.type === 'newSponsor') {
                        // New membership detected
                        sendMessageToClients({
                            type: 'MEMBER',
                            sender: message.authorDetails.displayName,
                            amount: "", // No amount for memberships
                            message: "Became a member!",
                        });
                    }
                });
            } catch (error) {
                console.error('Error fetching chat messages:', error);
            }
        }, 30000); // Poll every 30 seconds
    } catch (error) {
        console.error('Error fetching chat messages:', error);
    }
}

// WebSocket upgrade handler to connect the WebSocket server to the HTTP server
app.server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Visit http://localhost:${PORT}/auth to authenticate`);
});

// Upgrade HTTP server to support WebSockets
app.server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

