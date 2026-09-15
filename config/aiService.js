// config/aiService.js
// Resolves the sound-scout-ai service's base URL from AI_SERVICE_URL, which in
// some deployments points at a specific endpoint (e.g. ".../api/generate")
// rather than the bare origin. Shared by every proxy route that forwards to
// the AI service (server.js's voice/image proxies, routes/events.js's
// blueprint photo proxy).
function getAiServiceBaseUrl() {
    const envUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
    try {
        const parsed = new URL(envUrl);
        return parsed.origin;
    } catch (e) {
        return envUrl.replace(/\/api\/generate\/?$/, '').replace(/\/$/, '');
    }
}

module.exports = { getAiServiceBaseUrl };
