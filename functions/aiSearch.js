'use strict';

const https = require('https');

/**
 * Call the Anthropic API to interpret a natural-language search query
 * into structured search terms for the artisan repository.
 *
 * Returns { searchTerms: string[], category: string, interpretation: string }
 * Throws on API error or timeout.
 */
async function interpretSearchQuery(rawQuery) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
            role: 'user',
            content: `You are a search assistant for HandyHub, a home services marketplace in Ghana.

Convert the user's search into a structured query for finding artisans/tradespeople.

Available categories: electricals, plumbing, cooling, painting, carpentry, welding, cleaning, tiling, gardening, masonry, roofing, appliance repair, fumigation, interior design.

User query: "${rawQuery}"

Respond with JSON only, no explanation:
{"searchTerms":["primary keyword","alternative keyword"],"category":"best matching category","interpretation":"brief one-line description of what the user needs"}`,
        }],
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type':    'application/json',
                'x-api-key':       apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length':  Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(parsed.error.message || 'Anthropic API error'));
                        return;
                    }
                    const text = parsed.content?.[0]?.text || '{}';
                    const result = JSON.parse(text);
                    if (!Array.isArray(result.searchTerms) || !result.searchTerms[0]) {
                        reject(new Error('Unexpected AI response shape'));
                        return;
                    }
                    resolve(result);
                } catch {
                    reject(new Error('Failed to parse AI response'));
                }
            });
        });

        req.setTimeout(8000, () => req.destroy(new Error('AI request timed out')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { interpretSearchQuery };
