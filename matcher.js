// ShoppingSmart/matcher.js
const OpenAI = require('openai');

// It's best to use an Environment Variable for your key so it stays secret
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY 
});

async function verifyMatch(query, itemA, itemB) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "user", 
                content: `User searched for "${query}". 
                Item A: "${itemA}"
                Item B: "${itemB}"
                Are these the exact same product and size? Answer ONLY with 'YES' or 'NO'.`
            }],
            temperature: 0, // Keeps the AI answer consistent
        });
        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("AI matching failed:", error);
        return "MAYBE"; // Fallback if the AI is down
    }
}

module.exports = { verifyMatch };