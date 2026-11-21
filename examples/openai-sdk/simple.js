// Example of using OpenAI SDK with proxy for Qwen AI - simple request
// Installation: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Not used but required for SDK
});

async function simpleRequest() {
    try {
        console.log('Sending request to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Write 5 interesting facts about the ocean' }
            ],
            model: 'qwen-max-latest',
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nRequest successfully completed.');

    } catch (error) {
        console.error('Error executing request:', error);
    }
}

// Run
simpleRequest();
